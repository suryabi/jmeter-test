#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const uiDir = path.join(root, "ui");
const plansDir = path.join(root, "plans");

const MIN_NODE = [
  { major: 20, minor: 19 },
  { major: 22, minor: 12 }
];
const MIN_JMETER = { major: 5, minor: 4 };

function parseVersion(versionText) {
  const match = (versionText || "").match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] || 0),
    raw: match[0]
  };
}

function compareVersion(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function meetsMinVersion(actual, minimum) {
  if (!actual) return false;
  return compareVersion(actual, minimum) >= 0;
}

function meetsAnyNodeRequirement(actual) {
  if (!actual) return false;
  if (actual.major > 22) return true;
  return MIN_NODE.some((min) => meetsMinVersion(actual, min));
}

function runCommand(command, args = []) {
  const isWin = process.platform === "win32";
  const isBareName =
    !command.includes(path.sep) &&
    !path.isAbsolute(command) &&
    !/\.(exe|cmd|bat)$/i.test(command);

  return spawnSync(command, args, {
    encoding: "utf8",
    env: process.env,
    // Windows: npm/java/jmeter are .cmd shims — spawn needs shell or ENOENT.
    shell: isWin && isBareName
  });
}

function readNpmVersionFromEnv() {
  const userAgent = process.env.npm_config_user_agent || "";
  const match = userAgent.match(/npm\/(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

function runNpmVersionCheck() {
  const result = runCommand("npm", ["--version"]);
  if (result.status === 0) {
    return { ok: true, version: firstLine(result.stdout) };
  }

  if (process.env.npm_execpath && fs.existsSync(process.env.npm_execpath)) {
    const viaNode = runCommand(process.execPath, [process.env.npm_execpath, "--version"]);
    if (viaNode.status === 0) {
      return { ok: true, version: firstLine(viaNode.stdout), via: process.env.npm_execpath };
    }
  }

  const envVersion = readNpmVersionFromEnv();
  if (envVersion) {
    return { ok: true, version: envVersion, via: "npm run context" };
  }

  return { ok: false };
}

function firstLine(text) {
  return (text || "").trim().split(/\r?\n/).find(Boolean) || "";
}

function extractJmeterVersion(output) {
  const text = (output || "").trim();
  const versionMatch = text.match(/Version\s+(\d+\.\d+(?:\.\d+)?)/i);
  if (versionMatch) return parseVersion(versionMatch[1]);

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (/apache jmeter/i.test(line)) {
      const parsed = parseVersion(line);
      if (parsed) return parsed;
    }
  }

  for (const line of lines) {
    const parsed = parseVersion(line);
    if (parsed && parsed.major >= 3) return parsed;
  }

  return null;
}

function resolveJmeterBin() {
  return process.env.JMETER_BIN || "jmeter";
}

function hasLibExt(home) {
  return fs.existsSync(path.join(home, "lib", "ext"));
}

function resolveJmeterHome(jmeterBin) {
  if (process.env.JMETER_HOME && fs.existsSync(process.env.JMETER_HOME)) {
    return process.env.JMETER_HOME;
  }

  let candidateBin = jmeterBin;
  if (jmeterBin.includes(path.sep) && fs.existsSync(jmeterBin)) {
    try {
      candidateBin = fs.realpathSync(jmeterBin);
    } catch {
      candidateBin = jmeterBin;
    }
  } else {
    const which = runCommand(process.platform === "win32" ? "where" : "which", [jmeterBin]);
    if (which.status === 0) {
      const resolved = firstLine(which.stdout);
      if (resolved && fs.existsSync(resolved)) {
        try {
          candidateBin = fs.realpathSync(resolved);
        } catch {
          candidateBin = resolved;
        }
      }
    }
  }

  if (!candidateBin.includes(path.sep)) return null;

  const binDir = path.dirname(candidateBin);
  const installRoot = path.dirname(binDir);
  const candidates = [installRoot, path.join(installRoot, "libexec"), binDir];

  for (const home of candidates) {
    if (hasLibExt(home)) return home;
  }

  return null;
}

function hasJsonPlugins(jmeterHome) {
  if (!jmeterHome) return null;

  const searchDirs = [
    path.join(jmeterHome, "lib", "ext"),
    path.join(jmeterHome, "lib")
  ];

  const pluginPatterns = [
    /jmeter-plugins-json/i,
    /json.*jmeter/i,
    /jsonutils/i
  ];

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir);
    if (files.some((file) => pluginPatterns.some((pattern) => pattern.test(file)))) {
      return true;
    }
  }

  return false;
}

function planRequiresJsonPlugins() {
  if (!fs.existsSync(plansDir)) return false;

  const plans = fs.readdirSync(plansDir).filter((name) => name.endsWith(".jmx"));
  return plans.some((planFile) => {
    const content = fs.readFileSync(path.join(plansDir, planFile), "utf8");
    return content.includes("com.atlantbh.jmeter.plugins");
  });
}

function resolveJavaHomeFromJmeterWrapper(jmeterBin) {
  let wrapper = jmeterBin;
  if (!wrapper.includes(path.sep)) {
    const which = runCommand(process.platform === "win32" ? "where" : "which", [wrapper]);
    if (which.status === 0) wrapper = firstLine(which.stdout);
  }

  if (!wrapper || !fs.existsSync(wrapper)) return null;

  try {
    const content = fs.readFileSync(wrapper, "utf8");
    const patterns = [
      /(?:set\s+)?JAVA_HOME\s*=\s*"([^"]+)"/i,
      /(?:set\s+)?JAVA_HOME\s*=\s*'([^']+)'/i,
      /(?:set\s+)?JAVA_HOME\s*=\s*([^\s\r\n]+)/i,
      /JAVA_HOME\s*=\s*"([^"]+)"/i,
      /JAVA_HOME\s*=\s*'([^']+)'/i,
      /JAVA_HOME\s*=\s*([^\s\r\n]+)/
    ];
    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match && match[1] && !match[1].startsWith("%")) return match[1];
    }
  } catch {
    return null;
  }
}

function javaVersionFromBin(javaBin) {
  const result = runCommand(javaBin, ["-version"]);
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status !== 0 || /unable to locate a java runtime/i.test(output)) return null;

  const versionLine = firstLine(result.stderr || result.stdout);
  if (!versionLine || /unable to locate a java runtime/i.test(versionLine)) return null;

  return { bin: javaBin, versionLine };
}

function discoverJava(jmeterBin) {
  const candidates = [];
  const seen = new Set();

  function addCandidate(javaBin) {
    if (!javaBin || seen.has(javaBin)) return;
    seen.add(javaBin);
    candidates.push(javaBin);
  }

  const jmeterJavaHome = resolveJavaHomeFromJmeterWrapper(jmeterBin);
  if (jmeterJavaHome) {
    addCandidate(path.join(jmeterJavaHome, "bin", process.platform === "win32" ? "java.exe" : "java"));
  }

  if (process.env.JAVA_HOME) {
    addCandidate(path.join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java"));
  }

  if (process.platform === "darwin") {
    const javaHome = runCommand("/usr/libexec/java_home", []);
    if (javaHome.status === 0) {
      const home = firstLine(javaHome.stdout);
      if (home) addCandidate(path.join(home, "bin", "java"));
    }
  }

  if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    for (const base of [programFiles, programFilesX86]) {
      for (const vendor of ["Java", "Eclipse Adoptium", "Microsoft", "Amazon Corretto", "Zulu"]) {
        const vendorDir = path.join(base, vendor);
        if (!fs.existsSync(vendorDir)) continue;
        try {
          for (const entry of fs.readdirSync(vendorDir)) {
            const javaExe = path.join(vendorDir, entry, "bin", "java.exe");
            addCandidate(javaExe);
          }
        } catch {
          // ignore unreadable directories
        }
      }
    }
  }

  addCandidate(process.platform === "win32" ? "java.exe" : "java");
  addCandidate("java");

  for (const javaBin of candidates) {
    const info = javaVersionFromBin(javaBin);
    if (info) return info;
  }

  return null;
}

class Validator {
  constructor() {
    this.errors = [];
    this.warnings = [];
  }

  pass(label, detail) {
    console.log(`✓  ${label}${detail ? `: ${detail}` : ""}`);
  }

  fail(label, detail, fix) {
    this.errors.push(label);
    console.log(`✗  ${label}${detail ? `: ${detail}` : ""}`);
    if (fix) console.log(`   → ${fix}`);
  }

  warn(label, detail, fix) {
    this.warnings.push(label);
    console.log(`⚠  ${label}${detail ? `: ${detail}` : ""}`);
    if (fix) console.log(`   → ${fix}`);
  }

  checkNode() {
    const versionText = process.version;
    const version = parseVersion(versionText);
    if (!meetsAnyNodeRequirement(version)) {
      this.fail(
        "Node.js",
        versionText,
        "Install Node.js 20.19+ or 22.12+ (Angular 21 requires it). https://nodejs.org/"
      );
      return;
    }
    this.pass("Node.js", versionText);
  }

  checkNpm() {
    const result = runNpmVersionCheck();
    if (!result.ok) {
      this.fail("npm", "not found", "Install npm (ships with Node.js).");
      return;
    }

    const version = parseVersion(result.version);
    const detail =
      result.via && result.via !== "npm run context"
        ? `${result.version} (via ${result.via})`
        : result.version;
    this.pass("npm", detail);

    if (version && compareVersion(version, { major: 10, minor: 0, patch: 0 }) < 0) {
      this.warn("npm version", `${version.raw} (10+ recommended)`, "Upgrade npm: npm install -g npm@latest");
    }
  }

  checkJava(jmeterBin = resolveJmeterBin()) {
    const java = discoverJava(jmeterBin);
    if (!java) {
      this.fail(
        "Java",
        "not found on PATH or via JMeter launcher",
        "Install a JRE/JDK (11, 17, or 21). On macOS with Homebrew: brew install openjdk@21"
      );
      return;
    }

    const pathJava =
      javaVersionFromBin("java") || (process.platform === "win32" ? javaVersionFromBin("java.exe") : null);
    if (java.bin === "java" || java.bin === "java.exe" || pathJava) {
      this.pass("Java", java.versionLine);
      return;
    }

    this.pass("Java", `${java.versionLine} (via ${java.bin})`);
    this.warn(
      "Java on PATH",
      "system java is not usable (macOS stub or missing)",
      "JMeter will still work via its launcher JAVA_HOME. Optional: set JAVA_HOME and add it to PATH in your shell profile."
    );
  }

  checkJmeter() {
    const jmeterBin = resolveJmeterBin();
    const result = runCommand(jmeterBin, ["--version"]);
    const combinedOutput = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (result.status !== 0 && !/Version\s+\d+\.\d+/i.test(combinedOutput)) {
      this.fail(
        "JMeter",
        `"${jmeterBin}" not runnable`,
        'Install Apache JMeter 5.4+ and add it to PATH, or set JMETER_BIN to the full path (e.g. export JMETER_BIN=/opt/jmeter/bin/jmeter).'
      );
      return { bin: jmeterBin, home: null };
    }

    const version = extractJmeterVersion(combinedOutput);
    const versionLabel = version ? `Version ${version.raw}` : firstLine(combinedOutput);
    if (!version || !meetsMinVersion(version, MIN_JMETER)) {
      this.warn("JMeter version", versionLabel, "Plans target JMeter 5.4+. Upgrade if runs fail at compile time.");
    } else {
      this.pass("JMeter", versionLabel);
    }

    const home = resolveJmeterHome(jmeterBin);
    if (!home) {
      this.warn(
        "JMeter home",
        "could not resolve JMETER_HOME",
        "Set JMETER_HOME if plugin detection is inconclusive."
      );
    } else {
      this.pass("JMeter home", home);
    }

    return { bin: jmeterBin, home };
  }

  checkJsonPlugins(jmeterHome) {
    if (!planRequiresJsonPlugins()) {
      this.pass("JMeter JSON plugins", "not required by plans in ./plans");
      return;
    }

    const hasPlugins = hasJsonPlugins(jmeterHome);
    if (hasPlugins === null) {
      this.warn(
        "JMeter JSON plugins",
        "could not verify (JMETER_HOME unknown)",
        "Run: npm run install:jmeter-plugins after setting JMETER_HOME or JMETER_BIN"
      );
      return;
    }

    if (!hasPlugins) {
      this.fail(
        "JMeter JSON plugins",
        "jpgc-json not found in lib/ext",
        "Run: npm run install:jmeter-plugins  (copies vendored jars from vendor/jmeter-plugins/)"
      );
      return;
    }

    this.pass("JMeter JSON plugins", "jpgc-json detected");
  }

  checkDependencies() {
    const rootModules = path.join(root, "node_modules");
    const uiModules = path.join(uiDir, "node_modules");

    if (!fs.existsSync(rootModules)) {
      this.fail("API dependencies", "node_modules missing", "Run: npm install");
    } else {
      this.pass("API dependencies", "node_modules present");
    }

    if (!fs.existsSync(uiModules)) {
      this.fail("UI dependencies", "ui/node_modules missing", "Run: cd ui && npm install");
    } else {
      this.pass("UI dependencies", "ui/node_modules present");
    }
  }

  checkPlans() {
    if (!fs.existsSync(plansDir)) {
      this.fail("Plans directory", "./plans missing", "Create plans/ and add at least one .jmx file.");
      return;
    }

    const plans = fs
      .readdirSync(plansDir)
      .filter((name) => name.endsWith(".jmx"))
      .sort();

    if (plans.length === 0) {
      this.fail("JMeter plans", "no .jmx files in ./plans", "Add a plan such as plans/BIQ.jmx.");
      return;
    }

    this.pass("JMeter plans", plans.join(", "));
  }

  checkWritableRunsDir() {
    const runsDir = path.join(root, "runs");
    try {
      fs.mkdirSync(runsDir, { recursive: true });
      fs.accessSync(runsDir, fs.constants.W_OK);
      this.pass("Runs directory", runsDir);
    } catch (error) {
      this.fail("Runs directory", error.message, "Ensure ./runs is writable for run artifacts.");
    }
  }
}

function runValidation() {
  console.log("BriefingIQ JMeter Runner — prerequisite check\n");

  const validator = new Validator();
  validator.checkNode();
  validator.checkNpm();
  const jmeter = validator.checkJmeter();
  validator.checkJava(jmeter.bin);
  validator.checkJsonPlugins(jmeter.home);
  validator.checkDependencies();
  validator.checkPlans();
  validator.checkWritableRunsDir();

  console.log("");
  if (validator.errors.length > 0) {
    console.log(`Validation failed (${validator.errors.length} error${validator.errors.length === 1 ? "" : "s"}).`);
    if (validator.warnings.length > 0) {
      console.log(`${validator.warnings.length} warning${validator.warnings.length === 1 ? "" : "s"} also reported.`);
    }
    console.log("Fix the items above, then run: npm run validate");
    return { ok: false, errors: validator.errors, warnings: validator.warnings };
  }

  if (validator.warnings.length > 0) {
    console.log(`Validation passed with ${validator.warnings.length} warning${validator.warnings.length === 1 ? "" : "s"}.`);
  } else {
    console.log("All prerequisites met. You can start the app with: npm run dev");
  }

  return { ok: true, errors: [], warnings: validator.warnings };
}

if (require.main === module) {
  const result = runValidation();
  process.exit(result.ok ? 0 : 1);
}

module.exports = {
  runValidation,
  resolveJmeterBin,
  resolveJmeterHome,
  hasJsonPlugins
};
