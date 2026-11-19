# Third-party architecture references

JINI's native adapter in src/main/agentEngine/toolRegistry.ts is informed by the public tool/extension architecture of:

- OpenCode — https://github.com/anomalyco/opencode — MIT License.
- Cline — https://github.com/cline/cline — Apache License 2.0.

No complete upstream runtime package or source module is vendored by this change. The upstream public interfaces and lifecycle patterns were studied and adapted to JINI's existing host/runtime constraints. If upstream source files are vendored in a later migration, their original copyright notices and full license texts must be retained with those files.
