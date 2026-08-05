#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { loadEnvFile } = require("./load-env");

loadEnvFile();

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

function readJavaHomeFromScriptFile(scriptPath) {
  if (!scriptPath || !fs.existsSync(scriptPath)) return null;

  try {
    const content = fs.readFileSync(scriptPath, "utf8");
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
      const value = match?.[1]?.trim();
      if (value && !value.startsWith("%")) return value;
    }
  } catch {
    return null;
  }

  return null;
}

function javaExecutableForHome(javaHome) {
  if (!javaHome) return null;
  const javaExe = path.join(javaHome, "bin", process.platform === "win32" ? "java.exe" : "java");
  return fs.existsSync(javaExe) ? javaExe : null;
}

function resolveJavaHomeFromJmeterWrapper(jmeterBin) {
  let wrapper = jmeterBin;
  if (!wrapper.includes(path.sep)) {
    const which = runCommand(process.platform === "win32" ? "where" : "which", [wrapper]);
    if (which.status === 0) wrapper = firstLine(which.stdout);
  }

  return readJavaHomeFromScriptFile(wrapper);
}

const JMETER_JAVA_MIN_MAJOR = 11;
const JMETER_JAVA_PREFERRED_MAJORS = [21, 17, 11];

function is64BitJava(versionLine = "") {
  return /64-Bit|64-bit|amd64|x86_64/i.test(versionLine);
}

function getJavaMajorFromHome(javaHome) {
  const javaExe = javaExecutableForHome(javaHome);
  if (!javaExe) return null;
  const info = javaVersionFromBin(javaExe);
  return info ? parseJavaMajor(info.versionLine) : null;
}

function minStableJavaMajorForPlatform() {
  return process.platform === "win32" ? JMETER_JAVA_MIN_MAJOR : 8;
}

function resolveJavaHomeFromJmeterScripts(jmeterBin, jmeterHome) {
  const scriptCandidates = [];

  let wrapper = jmeterBin;
  if (!wrapper.includes(path.sep)) {
    const which = runCommand(process.platform === "win32" ? "where" : "which", [wrapper]);
    if (which.status === 0) wrapper = firstLine(which.stdout);
  }
  if (wrapper) scriptCandidates.push(wrapper);

  if (jmeterHome) {
    scriptCandidates.push(
      path.join(jmeterHome, "bin", "jmeter.bat"),
      path.join(jmeterHome, "bin", "jmeter.cmd"),
      path.join(jmeterHome, "bin", "jmeter"),
      path.join(jmeterHome, "bin", "setenv.bat"),
      path.join(jmeterHome, "bin", "setenv.sh")
    );
  }

  for (const scriptPath of scriptCandidates) {
    const javaHome = readJavaHomeFromScriptFile(scriptPath);
    if (javaHome && javaExecutableForHome(javaHome)) {
      return { javaHome, source: `jmeter-launcher (${path.basename(scriptPath)})` };
    }
  }

  return null;
}

function considerJmeterJavaHome(javaHome, seen, homes, minMajor) {
  if (!javaHome) return;
  const resolved = path.resolve(javaHome);
  if (seen.has(resolved)) return;

  const javaExe = javaExecutableForHome(javaHome);
  if (!javaExe) return;

  const info = javaVersionFromBin(javaExe);
  if (!info) return;

  const major = parseJavaMajor(info.versionLine);
  if (major == null || major < minMajor) return;
  if (process.platform === "win32" && !is64BitJava(info.versionLine)) return;

  seen.add(resolved);
  homes.push({
    home: javaHome,
    major,
    versionLine: info.versionLine,
    label: path.basename(javaHome.replace(/[/\\]$/, ""))
  });
}

function scanWindowsJavaInstallDirs(addHome) {
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";

  for (const base of [programFiles, programFilesX86]) {
    for (const vendor of ["Java", "Eclipse Adoptium", "Microsoft", "Amazon Corretto", "Zulu"]) {
      const vendorDir = path.join(base, vendor);
      if (!fs.existsSync(vendorDir)) continue;

      try {
        for (const entry of fs.readdirSync(vendorDir)) {
          addHome(path.join(vendorDir, entry));
        }
      } catch {
        // ignore unreadable directories
      }
    }
  }
}

/** Find installed JDK/JRE homes suitable for JMeter (Java 11+; 64-bit on Windows). */
function discoverJmeterJavaHomes(options = {}) {
  const minMajor = options.minMajor ?? JMETER_JAVA_MIN_MAJOR;
  const homes = [];
  const seen = new Set();

  function addHome(javaHome) {
    considerJmeterJavaHome(javaHome, seen, homes, minMajor);
  }

  if (process.env.JMETER_JAVA_HOME) addHome(process.env.JMETER_JAVA_HOME);

  for (const major of JMETER_JAVA_PREFERRED_MAJORS) {
    const portableRoot = path.join(root, ".jdk", `temurin-${major}`);
    if (fs.existsSync(portableRoot)) {
      addHome(portableRoot);
      try {
        for (const entry of fs.readdirSync(portableRoot)) {
          addHome(path.join(portableRoot, entry));
        }
      } catch {
        // ignore unreadable directories
      }
    }
  }

  if (process.platform === "darwin") {
    for (const major of JMETER_JAVA_PREFERRED_MAJORS) {
      const result = runCommand("/usr/libexec/java_home", ["-v", String(major)]);
      if (result.status === 0) addHome(firstLine(result.stdout));
    }
    const list = runCommand("/usr/libexec/java_home", ["-V"]);
    if (list.status === 0) {
      for (const line of list.stderr.split(/\r?\n/)) {
        const match = line.match(/^\s+(\S.+?\S)\s+\(/);
        if (match) addHome(match[1].trim());
      }
    }
  }

  if (process.platform === "win32") {
    scanWindowsJavaInstallDirs(addHome);
  }

  if (process.env.JAVA_HOME) addHome(process.env.JAVA_HOME);

  homes.sort((a, b) => {
    const prefA = JMETER_JAVA_PREFERRED_MAJORS.indexOf(a.major);
    const prefB = JMETER_JAVA_PREFERRED_MAJORS.indexOf(b.major);
    const rankA = prefA === -1 ? 99 : prefA;
    const rankB = prefB === -1 ? 99 : prefB;
    if (rankA !== rankB) return rankA - rankB;
    return b.major - a.major;
  });

  return homes;
}

function pickBestJmeterJavaHome(options = {}) {
  const exclude = new Set((options.exclude || []).map((home) => path.resolve(home)));
  return discoverJmeterJavaHomes(options).find((entry) => !exclude.has(path.resolve(entry.home))) || null;
}

// JMETER_JAVA_HOME (.env) overrides system JAVA_HOME so backend devs can keep Java 8 globally.
// On Windows, when only Java 8 is configured, auto-discover a newer 64-bit JDK if installed.
function resolveJavaHomeForJmeter(jmeterBin, jmeterHome, options = {}) {
  const allowAutoDiscover = options.allowAutoDiscover !== false;
  const minStableMajor = minStableJavaMajorForPlatform();

  if (process.env.JMETER_JAVA_HOME && javaExecutableForHome(process.env.JMETER_JAVA_HOME)) {
    return { javaHome: process.env.JMETER_JAVA_HOME, source: "JMETER_JAVA_HOME env" };
  }

  let resolved = resolveJavaHomeFromJmeterScripts(jmeterBin, jmeterHome);
  if (!resolved && process.env.JAVA_HOME && javaExecutableForHome(process.env.JAVA_HOME)) {
    resolved = { javaHome: process.env.JAVA_HOME, source: "JAVA_HOME env" };
  }

  if (resolved?.javaHome) {
    const major = getJavaMajorFromHome(resolved.javaHome);
    if (major != null && major >= minStableMajor) {
      return resolved;
    }

    if (allowAutoDiscover) {
      const better = pickBestJmeterJavaHome({ exclude: [resolved.javaHome] });
      if (better) {
        return {
          javaHome: better.home,
          source: `auto-discovered Java ${better.major} (${better.label}); skipped ${resolved.source} (Java ${major ?? "?"})`
        };
      }
    }

    return resolved;
  }

  if (allowAutoDiscover) {
    const discovered = pickBestJmeterJavaHome();
    if (discovered) {
      return {
        javaHome: discovered.home,
        source: `auto-discovered Java ${discovered.major} (${discovered.label})`
      };
    }
  }

  return { javaHome: null, source: null };
}

const PLUGIN_MANIFEST_PATH = path.join(root, "vendor", "jmeter-plugins", "manifest.json");

function loadPluginManifest() {
  if (!fs.existsSync(PLUGIN_MANIFEST_PATH)) return null;
  return JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_PATH, "utf8"));
}

function parseJavaMajor(versionLine) {
  if (!versionLine) return null;
  const quoted = versionLine.match(/version\s+"([^"]+)"/i);
  if (quoted) {
    const parts = quoted[1].split(".");
    if (parts[0] === "1" && parts[1]) return Number(parts[1]);
    return Number(parts[0]);
  }
  const parsed = parseVersion(versionLine);
  if (!parsed) return null;
  if (parsed.major === 1 && parsed.minor) return parsed.minor;
  return parsed.major;
}

function getJmeterJavaInfo(jmeterBin, jmeterHome) {
  const { javaHome, source } = resolveJavaHomeForJmeter(jmeterBin, jmeterHome);
  if (!javaHome) {
    return { javaHome: null, source: null, versionLine: null, major: null, javaExe: null };
  }
  const javaExe = javaExecutableForHome(javaHome);
  const info = javaExe ? javaVersionFromBin(javaExe) : null;
  return {
    javaHome,
    source,
    versionLine: info?.versionLine || null,
    major: info ? parseJavaMajor(info.versionLine) : null,
    javaExe
  };
}

function assessPluginBundleJavaCompatibility(manifest, javaMajor) {
  const min = manifest?.java?.minMajor ?? 8;
  const recommended = manifest?.java?.recommendedMajor ?? 11;

  if (javaMajor == null) {
    return {
      ok: false,
      level: "unknown",
      min,
      recommended,
      message: "Could not determine which Java JMeter will use"
    };
  }

  if (javaMajor < min) {
    return {
      ok: false,
      level: "error",
      min,
      recommended,
      message: `Java ${javaMajor} is too old for vendored plugins (need Java ${min}+)`
    };
  }

  if (javaMajor < recommended) {
    return {
      ok: true,
      level: "warn",
      min,
      recommended,
      message: `Java ${javaMajor} meets plugin minimum (Java ${min}+) but Java ${recommended}+ is recommended for JMeter 5.4+`
    };
  }

  return {
    ok: true,
    level: "pass",
    min,
    recommended,
    message: `Java ${javaMajor} is compatible with vendored jpgc-json bundle`
  };
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

  const jmeterJavaHome = resolveJavaHomeForJmeter(jmeterBin, resolveJmeterHome(jmeterBin)).javaHome;
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

function javaSetupSteps(options = {}) {
  const minMajor = minStableJavaMajorForPlatform();
  const steps = [];

  if (options.intro !== false) {
    steps.push(
      process.platform === "win32"
        ? "JMeter needs 64-bit Java 11+ (17+ recommended). System JAVA_HOME can stay on Java 8 for backend work."
        : "JMeter needs Java 11+ (17 recommended). Use JMETER_JAVA_HOME so system JAVA_HOME is unchanged."
    );
  }

  steps.push("npm run install:jmeter-java — download portable Temurin 17 into .jdk/ (no admin, all platforms)");
  steps.push("npm run setup:jmeter-java — or detect an installed JDK and write JMETER_JAVA_HOME to .env");
  steps.push("Manual install: https://adoptium.net/temurin/releases/?version=17 then re-run npm run setup:jmeter-java");
  steps.push("Copy .env.example → .env and set JMETER_HOME if JMeter is not on PATH");

  if (process.platform === "win32" && minMajor >= 11) {
    steps.push("After setup, restart npm run dev and confirm launcher.log shows javaHomeSource=JMETER_JAVA_HOME env (not jdk-1.8)");
  }

  return steps;
}

function jmeterSetupSteps() {
  const steps = [
    "Download Apache JMeter 5.4+ — https://jmeter.apache.org/download_jmeter.cgi"
  ];

  if (process.platform === "win32") {
    steps.push('Set JMETER_HOME in .env to your install folder (e.g. D:\\Softwares\\Jmeter 5.4\\Jmeter 5.4)');
    steps.push('Or set JMETER_BIN to the full path of bin\\jmeter.bat');
  } else {
    steps.push("Add JMeter bin/ to PATH, or set JMETER_BIN / JMETER_HOME in .env (see .env.example)");
  }

  steps.push("npm run install:jmeter-plugins — copy vendored jpgc-json plugins into JMeter");
  return steps;
}

function printSetupGuide(setupHints) {
  if (!setupHints || setupHints.size === 0) return;

  console.log("\n--- Setup help ---");

  if (setupHints.has("node")) {
    console.log("\nNode.js:");
    console.log("  1. Install Node.js 20.19+ or 22.12+ — https://nodejs.org/");
    console.log("  2. npm run init");
  }

  if (setupHints.has("java")) {
    console.log("\nJava for JMeter:");
    javaSetupSteps().forEach((line, index) => console.log(`  ${index + 1}. ${line}`));
  }

  if (setupHints.has("jmeter")) {
    console.log("\nApache JMeter:");
    jmeterSetupSteps().forEach((line, index) => console.log(`  ${index + 1}. ${line}`));
  }

  if (setupHints.has("plugins")) {
    console.log("\nJMeter JSON plugins (jpgc-json):");
    console.log("  1. Set JMETER_HOME in .env if not already set");
    console.log("  2. npm run install:jmeter-plugins");
    console.log("  3. npm run validate");
  }

  console.log("");
}

class Validator {
  constructor() {
    this.errors = [];
    this.warnings = [];
    this.setupHints = new Set();
  }

  pass(label, detail) {
    console.log(`✓  ${label}${detail ? `: ${detail}` : ""}`);
  }

  printFix(fix) {
    if (!fix) return;
    const lines = Array.isArray(fix) ? fix : [fix];
    for (const line of lines) {
      console.log(`   → ${line}`);
    }
  }

  fail(label, detail, fix) {
    this.errors.push(label);
    console.log(`✗  ${label}${detail ? `: ${detail}` : ""}`);
    this.printFix(fix);
  }

  warn(label, detail, fix) {
    this.warnings.push(label);
    console.log(`⚠  ${label}${detail ? `: ${detail}` : ""}`);
    this.printFix(fix);
  }

  requestSetupHint(kind) {
    this.setupHints.add(kind);
  }

  checkNode() {
    const versionText = process.version;
    const version = parseVersion(versionText);
    if (!meetsAnyNodeRequirement(version)) {
      this.requestSetupHint("node");
      this.fail(
        "Node.js",
        versionText,
        "Install Node.js 20.19+ or 22.12+ — https://nodejs.org/ then run: npm run init"
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

  checkJava(jmeterBin = resolveJmeterBin(), jmeterHome = null) {
    const home = jmeterHome || resolveJmeterHome(jmeterBin);
    const { javaHome, source } = resolveJavaHomeForJmeter(jmeterBin, home);
    const discovered = discoverJmeterJavaHomes();
    let jmeterJavaOk = false;

    if (javaHome) {
      const javaExe = javaExecutableForHome(javaHome);
      const jmeterJava = javaExe ? javaVersionFromBin(javaExe) : null;
      if (jmeterJava) {
        jmeterJavaOk = true;
        this.pass("Java (JMeter uses)", `${jmeterJava.versionLine} — ${source}`);
        const parsed = parseVersion(jmeterJava.versionLine);
        const minStable = minStableJavaMajorForPlatform();
        const major = parsed?.major === 1 ? parsed.minor : parsed?.major;
        if (major != null && major < minStable) {
          this.requestSetupHint("java");
          this.warn(
            "Java (JMeter)",
            process.platform === "win32"
              ? `Java ${major} is too old for JMeter on Windows (need ${minStable}+; Java 8 often crashes with exit 3221225477)`
              : `${parsed.raw} is older than recommended for JMeter 5.4+`,
            [
              "npm run install:jmeter-java  — download Temurin 17 into .jdk/",
              "npm run setup:jmeter-java  — or detect JDK 11+ already installed"
            ]
          );
        } else if (parsed && (parsed.major < 11 || (parsed.major === 1 && parsed.minor <= 8))) {
          this.requestSetupHint("java");
          this.warn(
            "Java (JMeter)",
            `${parsed.raw} is older than recommended for JMeter 5.4+`,
            [
              "npm run install:jmeter-java  — download Temurin 17 into .jdk/",
              "npm run setup:jmeter-java  — or set JMETER_JAVA_HOME in .env"
            ]
          );
        }
      } else {
        this.requestSetupHint("java");
        this.fail(
          "Java (JMeter uses)",
          `Java at ${source} is not runnable (${javaHome})`,
          "Fix JMETER_JAVA_HOME in .env or JAVA_HOME in JMETER_HOME/bin/setenv.bat / setenv.sh"
        );
      }
    } else {
      this.requestSetupHint("java");
      const discoverHint =
        discovered.length > 0
          ? `Found ${discovered.length} suitable JDK(s) on disk — run: npm run setup:jmeter-java`
          : "No suitable JDK found — run: npm run install:jmeter-java";
      this.warn(
        "Java (JMeter uses)",
        "could not resolve Java for JMeter",
        [
          discoverHint,
          "Copy .env.example → .env and set JMETER_HOME if JMeter is not on PATH"
        ]
      );
    }

    if (process.env.JAVA_HOME) {
      const envExe = javaExecutableForHome(process.env.JAVA_HOME);
      const envJava = envExe ? javaVersionFromBin(envExe) : null;
      if (envJava) {
        const same =
          javaHome &&
          path.resolve(process.env.JAVA_HOME) === path.resolve(javaHome);
        if (same) {
          this.pass("Java (JAVA_HOME env)", `same as JMeter — ${envJava.versionLine}`);
        } else {
          const label = jmeterJavaOk ? "ignored when JMeter Java is set" : "may be used as fallback";
          this.warn("Java (JAVA_HOME env)", `${envJava.versionLine} (${label})`);
        }
      } else {
        this.warn("Java (JAVA_HOME env)", `not runnable (${process.env.JAVA_HOME})`);
      }
    }

    const pathJava =
      javaVersionFromBin("java") || (process.platform === "win32" ? javaVersionFromBin("java.exe") : null);
    if (pathJava) {
      const jmeterExe = javaHome ? javaExecutableForHome(javaHome) : null;
      const sameAsJmeter =
        jmeterExe && path.resolve(pathJava.bin) === path.resolve(jmeterExe);
      if (!sameAsJmeter) {
        this.pass("Java (PATH)", pathJava.versionLine);
      }
    } else if (!process.env.JAVA_HOME) {
      this.warn("Java (PATH)", "system java not on PATH or not usable");
    }

    if (!jmeterJavaOk && !pathJava && !process.env.JAVA_HOME) {
      this.requestSetupHint("java");
      this.fail(
        "Java",
        "not found for JMeter or on PATH",
        [
          "npm run install:jmeter-java  — download Temurin 17 (keeps system JAVA_HOME unchanged)",
          "npm run setup:jmeter-java  — or detect an installed JDK 11+"
        ]
      );
    } else if (!jmeterJavaOk && !pathJava) {
      this.requestSetupHint("java");
      this.fail(
        "Java",
        "no runnable Java found for population runs",
        [
          "npm run install:jmeter-java  — download Temurin 17 into .jdk/",
          "npm run setup:jmeter-java  — or set JMETER_JAVA_HOME in .env"
        ]
      );
    }
  }

  checkJmeter() {
    const jmeterBin = resolveJmeterBin();
    const result = runCommand(jmeterBin, ["--version"]);
    const combinedOutput = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (result.status !== 0 && !/Version\s+\d+\.\d+/i.test(combinedOutput)) {
      this.requestSetupHint("jmeter");
      this.fail(
        "JMeter",
        `"${jmeterBin}" not runnable`,
        jmeterSetupSteps()
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
      this.requestSetupHint("jmeter");
      this.warn(
        "JMeter home",
        "could not resolve JMETER_HOME",
        "Set JMETER_HOME in .env (see .env.example) or JMETER_BIN to the jmeter executable"
      );
    } else {
      this.pass("JMeter home", home);
    }

    return { bin: jmeterBin, home };
  }

  checkJsonPlugins(jmeterHome, jmeterBin) {
    if (!planRequiresJsonPlugins()) {
      this.pass("JMeter JSON plugins", "not required by plans in ./plans");
      return;
    }

    const manifest = loadPluginManifest();
    const javaInfo = getJmeterJavaInfo(jmeterBin, jmeterHome);
    const compat = assessPluginBundleJavaCompatibility(manifest, javaInfo.major);

    if (compat.level === "error") {
      this.requestSetupHint("java");
      this.fail(
        "Plugin bundle + Java",
        compat.message,
        [
          "npm run install:jmeter-java  — download Temurin 17 into .jdk/",
          `npm run setup:jmeter-java  — or configure Java ${compat.recommended}+ via JMETER_JAVA_HOME in .env`
        ]
      );
      return;
    }
    if (compat.level === "unknown") {
      this.requestSetupHint("java");
      this.requestSetupHint("jmeter");
      this.warn(
        "Plugin bundle + Java",
        compat.message,
        "Set JMETER_HOME in .env, then run: npm run setup:jmeter-java"
      );
    } else if (compat.level === "warn") {
      this.requestSetupHint("java");
      this.warn(
        "Plugin bundle + Java",
        compat.message,
        [
          "npm run install:jmeter-java  — recommended on Windows to avoid JVM crashes",
          "Older Java may cause UnsupportedClassVersionError or access violations"
        ]
      );
    } else {
      this.pass("Plugin bundle + Java", compat.message);
    }

    const hasPlugins = hasJsonPlugins(jmeterHome);
    if (hasPlugins === null) {
      this.requestSetupHint("plugins");
      this.requestSetupHint("jmeter");
      this.warn(
        "JMeter JSON plugins",
        "could not verify (JMETER_HOME unknown)",
        [
          "Set JMETER_HOME in .env (see .env.example)",
          "npm run install:jmeter-plugins"
        ]
      );
      return;
    }

    if (!hasPlugins) {
      this.requestSetupHint("plugins");
      this.fail(
        "JMeter JSON plugins",
        "jpgc-json not found in lib/ext",
        [
          "npm run install:jmeter-plugins  — copies vendored jars from vendor/jmeter-plugins/",
          "Requires JMETER_HOME in .env if JMeter is not auto-detected"
        ]
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
  validator.checkJava(jmeter.bin, jmeter.home);
  validator.checkJsonPlugins(jmeter.home, jmeter.bin);
  validator.checkDependencies();
  validator.checkPlans();
  validator.checkWritableRunsDir();

  console.log("");
  printSetupGuide(validator.setupHints);

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
    if (validator.setupHints.has("java")) {
      console.log("Address Java warnings before running JMeter on Windows.");
    }
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
  hasJsonPlugins,
  planRequiresJsonPlugins,
  resolveJavaHomeFromJmeterWrapper,
  resolveJavaHomeFromJmeterScripts,
  resolveJavaHomeForJmeter,
  javaExecutableForHome,
  loadPluginManifest,
  getJmeterJavaInfo,
  assessPluginBundleJavaCompatibility,
  parseJavaMajor,
  discoverJmeterJavaHomes,
  pickBestJmeterJavaHome,
  getJavaMajorFromHome,
  minStableJavaMajorForPlatform,
  javaSetupSteps,
  jmeterSetupSteps,
  printSetupGuide
};
