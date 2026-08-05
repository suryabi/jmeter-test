const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { javaExecutableForHome, javaVersionFromBin, parseJavaMajor } = require("./validate");

const ADOPTIUM_API = "https://api.adoptium.net/v3/assets/latest";
const DEFAULT_MAJOR = 11;

function adoptiumPlatform() {
  const os = { win32: "windows", darwin: "mac", linux: "linux" }[process.platform];
  if (!os) {
    throw new Error(`Portable JDK install is not supported on ${process.platform}`);
  }

  const arch = process.arch === "arm64" ? "aarch64" : "x64";
  return { os, arch };
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
    shell: isWin && isBareName
  });
}

async function fetchTemurinAsset(major = DEFAULT_MAJOR) {
  const { os, arch } = adoptiumPlatform();
  const url =
    `${ADOPTIUM_API}/${major}/hotspot` +
    `?architecture=${arch}&image_type=jdk&os=${os}&project=jdk`;

  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Adoptium API error (${response.status}) for Java ${major} ${os}/${arch}`);
  }

  const assets = await response.json();
  if (!Array.isArray(assets) || assets.length === 0) {
    throw new Error(`No Temurin JDK ${major} package found for ${os}/${arch}`);
  }

  const zipAsset = assets.find((asset) => /\.zip$/i.test(asset?.binary?.package?.link || ""));
  const tarAsset = assets.find((asset) => /\.tar\.gz$/i.test(asset?.binary?.package?.link || ""));
  const asset = zipAsset || tarAsset || assets[0];
  const pkg = asset?.binary?.package;

  if (!pkg?.link || !pkg?.name) {
    throw new Error(`Adoptium returned an unexpected package shape for Java ${major}`);
  }

  return {
    major,
    link: pkg.link,
    name: pkg.name,
    size: pkg.size || null,
    version: asset.version?.semver || asset.version?.openjdk_version || String(major)
  };
}

async function downloadFile(url, destPath) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}): ${url}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buffer);
}

function extractArchive(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const lower = archivePath.toLowerCase();

  if (lower.endsWith(".zip")) {
    if (process.platform === "win32") {
      const ps = [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`
      ];
      const result = runCommand("powershell", ps);
      if (result.status !== 0) {
        throw new Error(firstLine(result.stderr || result.stdout) || "Expand-Archive failed");
      }
      return;
    }

    const result = runCommand("unzip", ["-q", archivePath, "-d", destDir]);
    if (result.status !== 0) {
      throw new Error(firstLine(result.stderr || result.stdout) || "unzip failed");
    }
    return;
  }

  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    const result = runCommand("tar", ["-xzf", archivePath, "-C", destDir]);
    if (result.status !== 0) {
      throw new Error(firstLine(result.stderr || result.stdout) || "tar extract failed");
    }
    return;
  }

  throw new Error(`Unsupported archive type: ${path.basename(archivePath)}`);
}

function firstLine(text) {
  return (text || "").trim().split(/\r?\n/).find(Boolean) || "";
}

function findExtractedJavaHome(extractRoot) {
  const javaBin = process.platform === "win32" ? "java.exe" : "java";
  const direct = path.join(extractRoot, "bin", javaBin);
  if (fs.existsSync(direct)) return extractRoot;

  if (!fs.existsSync(extractRoot)) return null;

  for (const entry of fs.readdirSync(extractRoot)) {
    const candidate = path.join(extractRoot, entry);
    try {
      if (!fs.statSync(candidate).isDirectory()) continue;
    } catch {
      continue;
    }
    const javaExe = path.join(candidate, "bin", javaBin);
    if (fs.existsSync(javaExe)) return candidate;
  }

  return null;
}

function describeJavaHome(javaHome) {
  const javaExe = javaExecutableForHome(javaHome);
  const info = javaExe ? javaVersionFromBin(javaExe) : null;
  return {
    home: javaHome,
    versionLine: info?.versionLine || null,
    major: info ? parseJavaMajor(info.versionLine) : null
  };
}

function existingPortableJavaHome(jdkRoot, major = DEFAULT_MAJOR) {
  const installDir = path.join(jdkRoot, `temurin-${major}`);
  const javaHome = findExtractedJavaHome(installDir);
  if (!javaHome) return null;

  const details = describeJavaHome(javaHome);
  if (details.major == null || details.major < major) return null;
  return details;
}

/**
 * Download Eclipse Temurin into a project-local folder (default: .jdk/temurin-11 for JMeter 5.4.x).
 * Does not modify system JAVA_HOME or install a global JDK.
 */
async function installPortableJmeterJava(options = {}) {
  const root = options.root || path.join(__dirname, "..");
  const major = Number(options.major || DEFAULT_MAJOR);
  const jdkRoot = options.jdkRoot || path.join(root, ".jdk");
  const installDir = path.join(jdkRoot, `temurin-${major}`);
  const quiet = Boolean(options.quiet);

  const existing = existingPortableJavaHome(jdkRoot, major);
  if (existing && !options.force) {
    if (!quiet) {
      console.log(`Reusing portable Temurin ${existing.major} at ${existing.home}`);
    }
    return { ok: true, reused: true, ...existing, installDir };
  }

  const asset = await fetchTemurinAsset(major);
  const archivePath = path.join(jdkRoot, "downloads", asset.name);

  if (!quiet) {
    const sizeMb = asset.size ? `${Math.round(asset.size / (1024 * 1024))} MB` : "unknown size";
    console.log(`Downloading Temurin JDK ${asset.version} (${sizeMb})...`);
    console.log(`  ${asset.link}`);
  }

  await downloadFile(asset.link, archivePath);

  if (!quiet) {
    console.log(`Extracting to ${installDir}...`);
  }

  if (fs.existsSync(installDir)) {
    fs.rmSync(installDir, { recursive: true, force: true });
  }

  extractArchive(archivePath, installDir);

  const javaHome = findExtractedJavaHome(installDir);
  if (!javaHome) {
    throw new Error(`Extract finished but bin/java was not found under ${installDir}`);
  }

  const details = describeJavaHome(javaHome);
  if (!quiet) {
    console.log(`Portable JDK ready: ${details.versionLine || `Java ${major}`}`);
    console.log(`  ${javaHome}`);
  }

  return { ok: true, reused: false, ...details, installDir, archivePath, asset };
}

module.exports = {
  installPortableJmeterJava,
  existingPortableJavaHome,
  adoptiumPlatform,
  DEFAULT_MAJOR
};
