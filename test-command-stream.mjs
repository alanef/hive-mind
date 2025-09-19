#!/usr/bin/env node

// Test command-stream behavior to debug Docker issues
const { use } = eval(await (await fetch('https://unpkg.com/use-m/use.js')).text());
globalThis.use = use;

console.log('[TEST] Loading command-stream...');
const commandStreamModule = await use('command-stream');
console.log('[TEST] Module loaded:', !!commandStreamModule);
console.log('[TEST] Module type:', typeof commandStreamModule);
console.log('[TEST] Module keys:', Object.keys(commandStreamModule || {}));

const { $ } = commandStreamModule;
console.log('[TEST] $ extracted:', typeof $, !!$);

// Test basic command
console.log('\n[TEST] Testing basic command: echo "hello"');
try {
  const cmd = $({ shell: true })`echo "hello"`;
  console.log('[TEST] Command object type:', typeof cmd);
  console.log('[TEST] Command object:', cmd);
  console.log('[TEST] Has Symbol.asyncIterator:', !!cmd?.[Symbol.asyncIterator]);
  console.log('[TEST] Command object keys:', Object.keys(cmd || {}));

  // Try to iterate
  console.log('\n[TEST] Attempting iteration...');

  // Method 1: Direct iteration
  if (cmd[Symbol.asyncIterator]) {
    console.log('[TEST] Using direct async iteration');
    for await (const chunk of cmd) {
      console.log('[TEST] Chunk:', chunk);
      if (chunk.done) break;
    }
  } else {
    console.log('[TEST] No Symbol.asyncIterator, trying await...');
    // Method 2: Await the command
    const result = await cmd;
    console.log('[TEST] Await result:', result);
  }
} catch (error) {
  console.error('[TEST] Error:', error.message);
  console.error('[TEST] Stack:', error.stack);
}

// Test with template literal
console.log('\n[TEST] Testing with template literal...');
try {
  const message = "world";
  const cmd2 = $({ shell: true })`echo "hello ${message}"`;
  console.log('[TEST] Command object type:', typeof cmd2);
  console.log('[TEST] Has Symbol.asyncIterator:', !!cmd2?.[Symbol.asyncIterator]);

  if (!cmd2[Symbol.asyncIterator]) {
    const result = await cmd2;
    console.log('[TEST] Template result:', result);
  } else {
    for await (const chunk of cmd2) {
      console.log('[TEST] Template chunk:', chunk);
      if (chunk.done) break;
    }
  }
} catch (error) {
  console.error('[TEST] Template error:', error.message);
}

console.log('\n[TEST] Done');