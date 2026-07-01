# Vendored JMeter JSON plugins (jpgc-json)

BriefingIQ test plans use `com.atlantbh.jmeter.plugins.jsonutils` elements. This folder ships the
**jpgc-json** plugin pack and its runtime dependencies so new machines can install them without
the JMeter Plugins Manager UI.

## Install into JMeter

From the repository root:

```bash
npm run install:jmeter-plugins
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
