#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const {
  resolveJmeterBin,
  resolveJmeterHome,
  loadPluginManifest
} = require("./validate");

function uninstallJmeterPlugins(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const jmeterHomeOverride = options.jmeterHome || process.env.JMETER_HOME;

  console.log("BriefingIQ JMeter Runner — remove vendored jpgc-json plugins\n");

  const manifest = loadPluginManifest();
  if (!manifest) {
    console.error("✗  Vendor manifest missing (vendor/jmeter-plugins/manifest.json)");
    return { ok: false, reason: "missing-manifest" };
  }

  const jmeterBin = resolveJmeterBin();
  const jmeterHome = jmeterHomeOverride || resolveJmeterHome(jmeterBin);

  if (!jmeterHome) {
    console.error("✗  Could not resolve JMETER_HOME.");
    console.error("   Set JMETER_HOME to your Apache JMeter directory.");
    return { ok: false, reason: "missing-jmeter-home" };
  }

  console.log(`Target JMeter home: ${jmeterHome}\n`);

  let removed = 0;
  let missing = 0;

  for (const jar of manifest.jars) {
    const fileName = path.basename(jar.file);
    const destPath = path.join(jmeterHome, jar.target, fileName);

    if (!fs.existsSync(destPath)) {
      console.log(`=  ${fileName} (not present)`);
      missing++;
      continue;
    }

    if (dryRun) {
      console.log(`~  would remove ${destPath}`);
      removed++;
      continue;
    }

    fs.unlinkSync(destPath);
    console.log(`✓  removed ${fileName} from ${jar.target}/`);
    removed++;
  }

  console.log("");
  if (dryRun) {
    console.log(`Dry run — would remove ${removed} file(s), ${missing} already absent.`);
    return { ok: true, dryRun: true, removed, missing, jmeterHome };
  }

  console.log(`Done. Removed ${removed} file(s), ${missing} were already absent.`);
  console.log("Other JMeter plugins you installed separately were not touched.\n");
  return { ok: true, removed, missing, jmeterHome };
}

if (require.main === module) {
  const dryRun = process.argv.includes("--dry-run");
  const result = uninstallJmeterPlugins({ dryRun });
  process.exit(result.ok ? 0 : 1);
}

module.exports = { uninstallJmeterPlugins };
