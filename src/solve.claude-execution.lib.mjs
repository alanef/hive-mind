/**
 * Claude execution module for solve.mjs
 * Handles the actual execution of Claude commands and processing of output
 */

import { spawn } from 'child_process';

export const executeClaudeCommand = async (params) => {
  const {
    tempDir,
    branchName,
    prompt,
    systemPrompt,
    escapedPrompt,
    escapedSystemPrompt,
    argv,
    log,
    formatAligned,
    getResourceSnapshot,
    forkedRepo,
    feedbackLines,
    claudePath
  } = params;

  // Execute claude command from the cloned repository directory
  await log(`\n${formatAligned('🤖', 'Executing Claude:', argv.model.toUpperCase())}`);

  if (argv.verbose) {
    // Output the actual model being used
    const modelName = argv.model === 'opus' ? 'opus' : 'sonnet';
    await log(`   Model: ${modelName}`, { verbose: true });
    await log(`   Working directory: ${tempDir}`, { verbose: true });
    await log(`   Branch: ${branchName}`, { verbose: true });
    await log(`   Prompt length: ${prompt.length} chars`, { verbose: true });
    await log(`   System prompt length: ${systemPrompt.length} chars`, { verbose: true });
    if (feedbackLines && feedbackLines.length > 0) {
      await log(`   Feedback info included: Yes (${feedbackLines.length} lines)`, { verbose: true });
    } else {
      await log('   Feedback info included: No', { verbose: true });
    }
  }

  // Take resource snapshot before execution
  const resourcesBefore = await getResourceSnapshot();
  await log('📈 System resources before execution:', { verbose: true });
  await log(`   Memory: ${resourcesBefore.memory.split('\n')[1]}`, { verbose: true });
  await log(`   Load: ${resourcesBefore.load}`, { verbose: true });

  // Use command-stream's async iteration for real-time streaming with file logging
  let commandFailed = false;
  let sessionId = null;
  let limitReached = false;
  let messageCount = 0;
  let toolUseCount = 0;
  let lastMessage = '';

  // Build claude command with optional resume flag
  let claudeArgs = `--output-format stream-json --verbose --dangerously-skip-permissions --model ${argv.model}`;

  if (argv.resume) {
    await log(`🔄 Resuming from session: ${argv.resume}`);
    claudeArgs = `--resume ${argv.resume} ${claudeArgs}`;
  }

  claudeArgs += ` -p "${escapedPrompt}" --append-system-prompt "${escapedSystemPrompt}"`;

  // Print the command being executed (with cd for reproducibility)
  const fullCommand = `(cd "${tempDir}" && ${claudePath} ${claudeArgs} | jq -c .)`;

  // Log the raw command for debugging and reproducibility
  await log(`\n${formatAligned('📝', 'Raw command:', '')}`);
  await log(`${fullCommand}\n`);

  await log(`${formatAligned('📋', 'Command details:', '')}`);
  await log(formatAligned('📂', 'Working directory:', tempDir, 2));
  await log(formatAligned('🌿', 'Branch:', branchName, 2));
  await log(formatAligned('🤖', 'Model:', `Claude ${argv.model.toUpperCase()}`, 2));
  if (argv.fork && forkedRepo) {
    await log(formatAligned('🍴', 'Fork:', forkedRepo, 2));
  }

  await log(`\n${formatAligned('▶️', 'Streaming output:', '')}\n`);

  // Use spawn instead of command-stream for more reliable execution
  // Build the full command as a shell command
  const shellCommand = `${claudePath} ${claudeArgs} | jq -c .`;

  // Create a promise to handle the spawn process
  const executeCommand = () => new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', shellCommand], {
      cwd: tempDir,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdoutBuffer = '';
    let stderrBuffer = '';
    let exitCode = null;
    let exitSignal = null;

    // Handle stdout
    child.stdout.on('data', async (data) => {
      const output = data.toString();
      stdoutBuffer += output;

      // Process complete lines from stdout
      const lines = stdoutBuffer.split('\n');
      // Keep the last incomplete line in buffer
      stdoutBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const data = JSON.parse(line);

          // Capture session ID from the first message
          if (!sessionId && data.session_id) {
            sessionId = data.session_id;
            await log(`📌 Session ID: ${sessionId}`, { verbose: true });
          }

          // Track message and tool use counts
          if (data.type === 'message') {
            messageCount++;
          } else if (data.type === 'tool_use') {
            toolUseCount++;
          }

          // Format the output nicely
          if (data.type === 'text') {
            // Text from assistant
            if (data.text) {
              await log(data.text, { stream: 'claude' });
              lastMessage = data.text;
            }
          } else if (data.type === 'tool_use' && data.name) {
            // Tool use - show a concise summary
            await log(`🔧 Using tool: ${data.name}`, { stream: 'tool', verbose: true });

            // For key tools, show their input in verbose mode
            if (argv.verbose && data.input) {
              if (data.name === 'bash' && data.input.command) {
                await log(`   $ ${data.input.command}`, { stream: 'tool-detail', verbose: true });
              } else if (data.name === 'write' && data.input.path) {
                await log(`   Writing to: ${data.input.path}`, { stream: 'tool-detail', verbose: true });
              } else if (data.name === 'read' && data.input.path) {
                await log(`   Reading: ${data.input.path}`, { stream: 'tool-detail', verbose: true });
              }
            }
          } else if (data.type === 'tool_result' && argv.verbose) {
            // Tool result in verbose mode - show if it's an error
            if (data.error) {
              await log(`   ⚠️  Tool error: ${data.error}`, { stream: 'tool-error', verbose: true });
            } else if (data.output && data.output.length < 200) {
              // Only show short outputs in verbose mode
              const output = data.output.replace(/\n/g, '\n   ');
              await log(`   Result: ${output}`, { stream: 'tool-result', verbose: true });
            }
          } else if (data.type === 'error') {
            // Error from Claude
            await log(`❌ Error: ${data.error || JSON.stringify(data)}`, { stream: 'error', level: 'error' });
            lastMessage = data.error || JSON.stringify(data);
          } else if (data.type === 'message' && data.role === 'assistant' && argv.verbose) {
            // Message metadata
            await log(`📨 Message ${messageCount} from assistant`, { stream: 'meta', verbose: true });
          }

        } catch {
          // Not JSON or parsing failed, output as-is if it's not empty
          if (line.trim() && !line.includes('node:internal')) {
            await log(line, { stream: 'raw' });
            lastMessage = line;
          }
        }
      }
    });

    // Handle stderr
    child.stderr.on('data', async (data) => {
      const errorOutput = data.toString();
      stderrBuffer += errorOutput;

      // Log stderr immediately
      if (errorOutput) {
        await log(errorOutput, { stream: 'stderr' });
      }
    });

    // Handle process exit
    child.on('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
    });

    child.on('close', async () => {
      // Process any remaining buffered stdout
      if (stdoutBuffer.trim()) {
        try {
          const data = JSON.parse(stdoutBuffer);

          if (data.type === 'text' && data.text) {
            await log(data.text, { stream: 'claude' });
            lastMessage = data.text;
          } else if (data.type === 'error') {
            await log(`❌ Error: ${data.error || JSON.stringify(data)}`, { stream: 'error', level: 'error' });
            lastMessage = data.error || JSON.stringify(data);
          }
        } catch {
          if (stdoutBuffer.trim() && !stdoutBuffer.includes('node:internal')) {
            await log(stdoutBuffer, { stream: 'raw' });
            lastMessage = stdoutBuffer;
          }
        }
      }

      resolve({ code: exitCode, signal: exitSignal, stdout: stdoutBuffer, stderr: stderrBuffer });
    });

    child.on('error', (err) => {
      reject(err);
    });
  });

  // Execute the command and wait for it to complete
  let commandResult;
  try {
    commandResult = await executeCommand();
  } catch (error) {
    await log(`\n\n❌ Failed to execute Claude command: ${error.message}`, { level: 'error' });
    return {
      success: false,
      sessionId,
      limitReached,
      messageCount,
      toolUseCount
    };
  }

  if (commandResult.code !== 0) {
    commandFailed = true;
    const exitReason = commandResult.signal ? ` (signal: ${commandResult.signal})` : '';

    // Check if we hit a rate limit
    if (lastMessage.includes('rate_limit_exceeded') ||
        lastMessage.includes('You have exceeded your rate limit') ||
        lastMessage.includes('rate limit')) {
      limitReached = true;
      await log('\n\n⏳ Rate limit reached. The session can be resumed later.', { level: 'warning' });

      if (sessionId) {
        await log(`📌 Session ID for resuming: ${sessionId}`);
        await log('\nTo continue when the rate limit resets, run:');
        await log(`   ${process.argv[0]} ${process.argv[1]} --auto-continue ${argv.url}`);
      }
    } else if (lastMessage.includes('context_length_exceeded')) {
      await log('\n\n❌ Context length exceeded. Try with a smaller issue or split the work.', { level: 'error' });
    } else {
      await log(`\n\n❌ Claude command failed with exit code ${commandResult.code}${exitReason}`, { level: 'error' });
      if (sessionId && !argv.resume) {
        await log(`📌 Session ID for resuming: ${sessionId}`);
        await log('\nTo resume this session, run:');
        await log(`   ${process.argv[0]} ${process.argv[1]} ${argv.url} --resume ${sessionId}`);
      }
    }
  }

  // Check if command failed
  if (commandFailed) {
    // Take resource snapshot after failure
    const resourcesAfter = await getResourceSnapshot();
    await log('\n📈 System resources after execution:', { verbose: true });
    await log(`   Memory: ${resourcesAfter.memory.split('\n')[1]}`, { verbose: true });
    await log(`   Load: ${resourcesAfter.load}`, { verbose: true });

    // If --attach-logs is enabled, ensure we attach failure logs
    if (argv.attachLogs && sessionId) {
      await log('\n📄 Attempting to attach failure logs to PR/Issue...');
      // The attach logs logic will handle this in the catch block below
    }

    return {
      success: false,
      sessionId,
      limitReached,
      messageCount,
      toolUseCount
    };
  }

  await log('\n\n✅ Claude command completed');
  await log(`📊 Total messages: ${messageCount}, Tool uses: ${toolUseCount}`);

  return {
    success: true,
    sessionId,
    limitReached,
    messageCount,
    toolUseCount
  };
};

// Helper function to execute a simple command using spawn
const execCommand = (command, cwd) => {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], {
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });

    child.on('error', (err) => {
      resolve({ code: 1, stdout: '', stderr: err.message });
    });
  });
};

export const checkForUncommittedChanges = async (tempDir, owner, repo, branchName, _$, log) => {
  // Check for and commit any uncommitted changes made by Claude
  await log('\n🔍 Checking for uncommitted changes...');
  try {
    // Check git status to see if there are any uncommitted changes
    const gitStatusResult = await execCommand('git status --porcelain 2>&1', tempDir);

    if (gitStatusResult.code === 0) {
      const statusOutput = gitStatusResult.stdout.trim();

      if (statusOutput) {
        await log('📝 Found uncommitted changes');
        await log('Changes:', { verbose: true });
        for (const line of statusOutput.split('\n')) {
          await log(`   ${line}`, { verbose: true });
        }

        // Auto-commit the changes
        await log('💾 Committing changes automatically...');

        const addResult = await execCommand('git add -A', tempDir);
        if (addResult.code === 0) {
          const commitMessage = 'Auto-commit: Changes made by Claude during problem-solving session';
          const commitResult = await execCommand(`git commit -m "${commitMessage}"`, tempDir);

          if (commitResult.code === 0) {
            await log('✅ Changes committed successfully');

            // Push the changes
            await log('📤 Pushing changes to remote...');
            const pushResult = await execCommand(`git push origin ${branchName}`, tempDir);

            if (pushResult.code === 0) {
              await log('✅ Changes pushed successfully');
            } else {
              await log(`⚠️ Warning: Could not push changes: ${pushResult.stderr.trim()}`, { level: 'warning' });
            }
          } else {
            await log(`⚠️ Warning: Could not commit changes: ${commitResult.stderr.trim()}`, { level: 'warning' });
          }
        } else {
          await log(`⚠️ Warning: Could not stage changes: ${addResult.stderr.trim()}`, { level: 'warning' });
        }
      } else {
        await log('✅ No uncommitted changes found');
      }
    } else {
      await log(`⚠️ Warning: Could not check git status: ${gitStatusResult.stderr.trim()}`, { level: 'warning' });
    }
  } catch (gitError) {
    await log(`⚠️ Warning: Error checking for uncommitted changes: ${gitError.message}`, { level: 'warning' });
  }
};