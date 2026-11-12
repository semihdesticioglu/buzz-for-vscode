// Stands in for the Buzz CLI while capture.js runs: starts the real CLI with the same arguments, environment and input,
// passes its output and exit code through unchanged, and writes what happened to a file of its own in a temporary
// folder (the extension runs some commands at the same time; capture.js anonymises the files and deletes the folder).
// The environment, and with it the key, is passed on and never written.
//   node recorder.js <folder> <path to buzz, or a .js stand-in for tests> ...arguments
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const [dir, cli, ...args] = process.argv.slice(2);
const file = path.join(dir, `${Date.now()}-${process.pid}.json`);
const [exe, pre] = /\.js$/i.test(cli) ? [process.execPath, [cli]] : [cli, []];
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const child = spawn(exe, [...pre, ...args], { env: process.env, windowsHide: true });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  child.on('error', (e) => {
    fs.writeFileSync(file, JSON.stringify({ args, code: null, stdout: '', stderr: e.message }));
    process.stderr.write(e.message);
    process.exitCode = 4;
  });
  child.on('close', (code) => {
    fs.writeFileSync(file, JSON.stringify({ args, code, stdout: out, stderr: err }));
    process.stdout.write(out);
    process.stderr.write(err);
    process.exitCode = code ?? 4;
  });
  child.stdin.on('error', () => undefined);
  child.stdin.end(input, 'utf8');
});
