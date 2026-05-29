#!/usr/bin/env node

const { execSync, spawnSync } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "..");
const uiDir = path.join(root, "ui");

function run(label, command, cwd = root) {
  console.log(`\n==> ${label}`);
  execSync(command, { cwd, stdio: "inherit" });
}

function check(command, args, label) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    console.warn(`\n⚠  ${label} not found. Install it and ensure it is on PATH.`);
    if (label === "JMeter") {
      console.warn("   Or set JMETER_BIN to the full path of the jmeter executable.");
    }
    return false;
  }

  const version = (result.stdout || result.stderr || "").trim().split("\n")[0];
  console.log(`✓  ${label}: ${version}`);
  return true;
}

console.log("BriefingIQ JMeter Runner — setup\n");

run("Installing API dependencies", "npm install", root);
run("Installing UI dependencies", "npm install", uiDir);

console.log("\n==> Checking prerequisites");
check("node", ["--version"], "Node.js");
check("npm", ["--version"], "npm");
check("jmeter", ["--version"], "JMeter");

console.log("\nSetup complete.");
console.log("Start both servers with: npm run dev");
console.log("  API: http://localhost:5050");
console.log("  UI:  http://localhost:4200\n");
