# Vendored JMeter JSON plugins (jpgc-json)

BriefingIQ test plans use `com.atlantbh.jmeter.plugins.jsonutils` elements. This folder ships the
**jpgc-json** plugin pack and its runtime dependencies so new machines can install them without
the JMeter Plugins Manager UI.

Our vendored pack (see `manifest.json`) requires **Java 8+**; **Java 11+** is recommended for JMeter 5.4+.
`npm run validate` checks **Java (JMeter uses)** against these limits before recommending install.

## Install into JMeter

From the repository root:

```bash
npm run install:jmeter-plugins
```

Re-running install is safe — it overwrites only our vendored files (skips identical copies).

To remove only our vendored jars from JMeter (not other plugins you added separately):

```bash
npm run uninstall:jmeter-plugins
```

Preview removals:

```bash
npm run uninstall:jmeter-plugins -- --dry-run
```

Copies JARs into your JMeter installation:

- `lib/ext/` — plugin entry (`jmeter-plugins-json-2.7.jar`)
- `lib/` — supporting libraries

Requires `JMETER_HOME` or a discoverable `jmeter` / `JMETER_BIN` on PATH (same as `npm run validate`).

## Contents

| JAR | Role |
|-----|------|
| `jmeter-plugins-json-2.7.jar` | JSON Format Post Processor and related plugin classes |
| `jmeter-plugins-cmn-jmeter-0.7.jar` | JMeter Plugins common library |
| `json-lib-2.4-jdk15.jar` | JSON-lib dependency |
| `json-path-2.8.0.jar` | JsonPath dependency |
| `json-smart-2.5.0.jar` | JsonPath transitive dependency |
| `snakeyaml-1.21.jar` | YAML support dependency |

## License

The plugin artifacts are from [jmeter-plugins.org](https://jmeter-plugins.org/) / [undera/jmeter-plugins](https://github.com/undera/jmeter-plugins) and are licensed under the **Apache License 2.0**.

Dependency JARs retain their respective upstream licenses (also Apache-compatible).
