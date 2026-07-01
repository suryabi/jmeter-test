#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { loadEnvFile } = require("./load-env");

loadEnvFile();

const {
  resolveJmeterBin,
  resolveJmeterHome,
  hasJsonPlugins,
  loadPluginManifest,
  getJmeterJavaInfo,
  assessPluginBundleJavaCompatibility
} = require("./validate");

const root = path.join(__dirname, "..");
const vendorDir = path.join(root, "vendor", "jmeter-plugins");
const manifestPath = path.join(vendorDir, "manifest.json");

function loadManifest() {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing vendor manifest: ${manifestPath}`);
  }
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function shouldCopy(sourcePath, destPath) {
  if (!fs.existsSync(destPath)) return true;
  return fs.statSync(sourcePath).size !== fs.statSync(destPath).size;
}

function copyJar(sourcePath, destPath, dryRun, quiet) {
  const fileName = path.basename(sourcePath);
  if (!shouldCopy(sourcePath, destPath)) {
    if (!quiet) console.log(`=  ${fileName} (already present)`);
    return { copied: false, skipped: true };
  }

  if (dryRun) {
    if (!quiet) console.log(`~  would copy ${fileName} → ${destPath}`);
    return { copied: false, skipped: false, planned: true };
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(sourcePath, destPath);
  if (!quiet) console.log(`✓  copied ${fileName} → ${destPath}`);
  return { copied: true, skipped: false };
}

function installJmeterPlugins(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const quiet = Boolean(options.quiet);
  const jmeterHomeOverride = options.jmeterHome || process.env.JMETER_HOME;

  if (!quiet) {
    console.log("BriefingIQ JMeter Runner — install jpgc-json plugins\n");
  }

  if (!fs.existsSync(vendorDir)) {
    console.error(`✗  Vendor bundle missing: ${vendorDir}`);
    return { ok: false, reason: "missing-vendor" };
  }

  const manifest = loadManifest();
  const jmeterBin = resolveJmeterBin();
  const jmeterHome = jmeterHomeOverride || resolveJmeterHome(jmeterBin);

  if (!jmeterHome) {
    console.error("✗  Could not resolve JMETER_HOME.");
    console.error("   Set JMETER_HOME to your Apache JMeter directory, or set JMETER_BIN to the jmeter executable.");
    return { ok: false, reason: "missing-jmeter-home" };
  }

  if (!dryRun && hasJsonPlugins(jmeterHome)) {
    if (!quiet) {
      console.log(`JMeter already has JSON plugins at: ${jmeterHome}`);
      console.log("Installing/updating vendored jars anyway (skips identical files)...\n");
    }
  } else if (!quiet) {
    console.log(`Target JMeter home: ${jmeterHome}\n`);
  }

  const javaInfo = getJmeterJavaInfo(jmeterBin, jmeterHome);
  if (!quiet && javaInfo.versionLine) {
    console.log(`JMeter Java: ${javaInfo.versionLine}${javaInfo.source ? ` (${javaInfo.source})` : ""}`);
  }
  const compat = assessPluginBundleJavaCompatibility(manifest, javaInfo.major);
  if (compat.level === "error") {
    console.error(`✗  ${compat.message}`);
    console.error(`   Vendored plugins need Java ${compat.min}+. Configure Java ${compat.recommended}+ in jmeter.bat / setenv.bat.\n`);
    return { ok: false, reason: "java-incompatible", jmeterHome, javaInfo, compat };
  }
  if (compat.level === "warn") {
    console.warn(`⚠  ${compat.message}`);
    console.warn("   Installing anyway — upgrade Java if runs crash or show UnsupportedClassVersionError.\n");
  } else if (compat.level === "pass" && !quiet) {
    console.log(`✓  ${compat.message}\n`);
  } else if (!quiet) {
    console.warn(`⚠  ${compat.message}\n`);
  }

  let copied = 0;
  let skipped = 0;
  let missing = 0;

  for (const jar of manifest.jars) {
    const sourcePath = path.join(vendorDir, jar.file);
    if (!fs.existsSync(sourcePath)) {
      console.log(`✗  missing vendored file: ${jar.file}`);
      missing++;
      continue;
    }

    const destPath = path.join(jmeterHome, jar.target, path.basename(jar.file));
    const result = copyJar(sourcePath, destPath, dryRun, quiet);
    if (result.copied) copied++;
    if (result.skipped) skipped++;
  }

  if (!quiet) console.log("");
  if (missing > 0) {
    console.error(`Install failed — ${missing} vendored file(s) missing from the repository.`);
    return { ok: false, reason: "missing-jars", copied, skipped, missing };
  }

  if (dryRun) {
    console.log("Dry run complete. Run without --dry-run to copy files.");
    return { ok: true, dryRun: true, jmeterHome };
  }

  const installed = hasJsonPlugins(jmeterHome);
  if (!installed) {
    console.error("Install finished but JSON plugin jar still not detected. Check JMETER_HOME permissions.");
    return { ok: false, reason: "verify-failed", copied, skipped };
  }

  if (!quiet) {
    console.log(`Done. Copied ${copied} file(s), skipped ${skipped} unchanged.`);
    console.log("Restart any running JMeter process before the next population run.\n");
  }
  return { ok: true, copied, skipped, jmeterHome };
}

if (require.main === module) {
  const dryRun = process.argv.includes("--dry-run");
  const result = installJmeterPlugins({ dryRun });
  process.exit(result.ok ? 0 : 1);
}

module.exports = { installJmeterPlugins };
