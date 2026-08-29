/**
 * AH5: HOST-SIDE serialization tail, originally for {@link toggleDashboard}
 * alone (moved verbatim off `AcpBackend`). Task A5 (§4.5) widened its use to
 * every dashboard-mutating control method; F3 NARROWED that again — this
 * tail now serializes every SHORT config-mutating method only
 * (`skills.toggle`/`toolsets.toggle`/`mcp.add`/`mcp.remove`/
 * `mcp.setEnabled`, and Task B4's `skills.create`), so two of OUR requests
 * can never interleave two read-modify-write cycles on the same underlying
 * `~/.hermes/config.yaml`. The four {@link TAIL_EXEMPT_MCP_METHODS}
 * (`mcp.catalog`/`mcp.test`/`mcp.auth`/`mcp.catalogInstall`) and the four
 * {@link SKILLS_TAIL_EXEMPT_METHODS} (`skills.hubPreview`/`skills.hubScan`/
 * `skills.hubInstall` — Task B4; `skills.hubUninstall` — Task B5) run OFF
 * this tail instead — none of them performs a client-bracketable config
 * write of its own (`hubInstall`/`hubUninstall`'s only write happens
 * server-side, at the END of the action, same membership rule as the MCP
 * set) — with same-name/same-identifier exclusion carried by {@link
 * busyMcpNames}/{@link busySkillInstallIds}/{@link busySkillUninstallNames}
 * instead. Tail-exempting the up-to-120s
 * `skills.hubInstall`/`skills.hubUninstall` polls is the whole point:
 * holding the tail for one would freeze every other short config mutation
 * behind a single slow install/uninstall — the exact regression this
 * mirrors away from.
 */
export class ConfigWriteTail {
  private tail: Promise<unknown> = Promise.resolve();

  join<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(run, run);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
