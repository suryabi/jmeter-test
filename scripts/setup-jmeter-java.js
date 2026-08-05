#!/usr/bin/env node

const path = require("path");
const { loadEnvFile, upsertEnvFile } = require("./load-env");
const { installPortableJmeterJava } = require("./install-portable-jmeter-java");
const {
  resolveJmeterBin,
  resolveJmeterHome,
  pickBestJmeterJavaHome,
  getJmeterJavaInfo,
  getJmeterVersionInfo,
  minStableJavaMajorForPlatform,
  maxJavaMajorForJmeter,
  recommendedPortableJavaMajor,
  assessJmeterRuntimeJavaCompatibility
} = require("./validate");

loadEnvFile();

const root = path.join(__dirname, "..");
const envPath = path.join(root, ".env");

function wantsInstall(argv = process.argv.slice(2)) {
  return argv.includes("--install") || argv.includes("-i");
}

function printInstallHint(jmeterVersion) {
  const portableMajor = recommendedPortableJavaMajor(jmeterVersion);
  console.error("No suitable Java found for JMeter.");
  console.error("");
  if (jmeterVersion && maxJavaMajorForJmeter(jmeterVersion) < 17) {
    console.error(`JMeter ${jmeterVersion.raw} requires Java 11 (not 17 — Groovy 3.0.x breaks JSR223 scripts on Java 17).`);
    console.error("");
  }
  console.error("Options:");
  console.error(`  1. Auto-download Temurin ${portableMajor} into .jdk/ (no admin, keeps JAVA_HOME on Java 8):`);
  console.error("       npm run install:jmeter-java");
  console.error("  2. Install manually, then re-run setup:");
  console.error(`       https://adoptium.net/temurin/releases/?version=${portableMajor}`);
}

function writeEnv(javaHome, jmeterHome) {
  const updates = { JMETER_JAVA_HOME: javaHome };
  if (jmeterHome && !process.env.JMETER_HOME) {
    updates.JMETER_HOME = jmeterHome;
  }

  upsertEnvFile(envPath, updates);

  console.log(`Updated ${envPath}:`);
  for (const [key, value] of Object.entries(updates)) {
    console.log(`  ${key}=${value}`);
  }
  console.log("");
  console.log("System JAVA_HOME is unchanged — backend work can stay on Java 8.");
  console.log("Restart npm run dev (or the API server), then run: npm run validate");
}

async function main() {
  console.log("BriefingIQ JMeter Runner — configure Java for JMeter only\n");

  const jmeterBin = resolveJmeterBin();
  const jmeterHome = process.env.JMETER_HOME || resolveJmeterHome(jmeterBin);
  const jmeterVersion = getJmeterVersionInfo(jmeterBin);
  const recommendedMajor = recommendedPortableJavaMajor(jmeterVersion);
  const maxJavaMajor = maxJavaMajorForJmeter(jmeterVersion);
  const current = getJmeterJavaInfo(jmeterBin, jmeterHome);
  const minStable = minStableJavaMajorForPlatform();
  const runtimeCompat = assessJmeterRuntimeJavaCompatibility(jmeterVersion, current.major);

  if (jmeterVersion) {
    console.log(`Detected JMeter ${jmeterVersion.raw} — use Java 11${maxJavaMajor >= 17 ? " or 17+" : ""} for JMeter\n`);
  }

  if (
    current.javaHome &&
    current.major != null &&
    current.major >= minStable &&
    runtimeCompat.ok
  ) {
    console.log(`JMeter already uses Java ${current.major}:`);
    console.log(`  ${current.versionLine}`);
    console.log(`  ${current.javaHome}`);
    console.log(`  source: ${current.source}`);
    console.log("\nNo change needed. To pin a different JDK, set JMETER_JAVA_HOME in .env manually.");
    return;
  }

  if (!runtimeCompat.ok) {
    console.warn(`⚠  ${runtimeCompat.message}\n`);
  }

  let chosen = pickBestJmeterJavaHome({ maxMajor: maxJavaMajor });

  const shouldInstall = wantsInstall() || (!runtimeCompat.ok && current.major != null);

  if (!chosen && shouldInstall) {
    console.log(`Downloading portable Temurin ${recommendedMajor} for JMeter ${jmeterVersion?.raw || "5.4.x"}...\n`);
    const installed = await installPortableJmeterJava({ root, major: recommendedMajor });
    chosen = {
      home: installed.home,
      major: installed.major,
      versionLine: installed.versionLine,
      label: path.basename(installed.home)
    };
  }

  if (!chosen) {
    printInstallHint(jmeterVersion);
    process.exit(1);
  }

  writeEnv(chosen.home, jmeterHome);

  console.log(`Selected Java ${chosen.major} for JMeter runs only:`);
  console.log(`  ${chosen.versionLine}`);
  console.log(`  ${chosen.home}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Setup failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main, wantsInstall };
