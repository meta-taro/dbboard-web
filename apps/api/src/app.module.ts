import Anthropic from "@anthropic-ai/sdk";
import { Module } from "@nestjs/common";
import { readAiProvidersConfig, type AiProviderConfigEntry } from "./bootstrap/ai-providers.config";
import {
  AI_PROVIDER_REGISTRY,
  type AiProviderRegistry,
} from "./domain/ai/ai-provider-registry.port";
import { DATABASE_ADAPTER } from "./domain/database-adapter.port";
import { AnthropicProvider, type AnthropicClient } from "./infrastructure/anthropic-provider";
import { InMemoryConnectionRegistry } from "./infrastructure/in-memory-connection-registry";
import { InMemoryHistoryStore } from "./infrastructure/in-memory-history-store";
import { NullAdapter } from "./infrastructure/null-adapter";
import { SshHostKeyProber } from "./infrastructure/ssh-host-key-prober";
import { StaticAdapterFactory } from "./infrastructure/static-adapter-factory";
import {
  StaticAiProviderRegistry,
  type AiProviderEntry,
} from "./infrastructure/static-ai-provider-registry";
import { AiController } from "./presentation/ai.controller";
import { CapabilitiesController } from "./presentation/capabilities.controller";
import { ConnectionCapabilitiesController } from "./presentation/connection-capabilities.controller";
import { ConnectionDumpController } from "./presentation/connection-dump.controller";
import { ConnectionRestoreController } from "./presentation/connection-restore.controller";
import { ConnectionRowsController } from "./presentation/connection-rows.controller";
import { ConnectionSchemaController } from "./presentation/connection-schema.controller";
import { ConnectionTablesController } from "./presentation/connection-tables.controller";
import { ConnectionsController } from "./presentation/connections.controller";
import { HealthController } from "./presentation/health.controller";
import { HistoryController } from "./presentation/history.controller";
import { HistoryRecordingInterceptor } from "./presentation/interceptors/history-recording.interceptor";
import { QueryController } from "./presentation/query.controller";
import { TablesController } from "./presentation/tables.controller";
import { ADAPTER_FACTORY } from "./usecase/adapter-factory.port";
import { CONNECTION_REGISTRY } from "./usecase/connection-registry.port";
import { DeleteConnection } from "./usecase/delete-connection.use-case";
import { DescribeTable } from "./usecase/describe-table.use-case";
import { DumpDatabase } from "./usecase/dump-database.use-case";
import { ExecuteQuery } from "./usecase/execute-query.use-case";
import { ExplainSql } from "./usecase/explain-sql.use-case";
import { ExportHistory } from "./usecase/export-history.use-case";
import { GetCapabilities } from "./usecase/get-capabilities.use-case";
import { GetConnectionCapabilities } from "./usecase/get-connection-capabilities.use-case";
import { GetHealth } from "./usecase/get-health.use-case";
import { HISTORY_STORE, type HistoryStore } from "./usecase/history-store.port";
import { ListAiProviders } from "./usecase/list-ai-providers.use-case";
import { ListConnectionTables } from "./usecase/list-connection-tables.use-case";
import { ListConnections } from "./usecase/list-connections.use-case";
import { ListDrivers } from "./usecase/list-drivers.use-case";
import { ListTables } from "./usecase/list-tables.use-case";
import { ProbeSshHostKey } from "./usecase/probe-ssh-host-key.use-case";
import { RecordHistory } from "./usecase/record-history.use-case";
import { RegisterConnection } from "./usecase/register-connection.use-case";
import { RestoreDatabase } from "./usecase/restore-database.use-case";
import { SSH_HOST_KEY_PROBE } from "./usecase/ssh-host-key-probe.port";
import { SuggestSql } from "./usecase/suggest-sql.use-case";
import { UpdateConnection } from "./usecase/update-connection.use-case";
import { UpdateRow } from "./usecase/update-row.use-case";

// Layered structure (per AI_AGENT_RULES.md §3):
//   src/domain          — business rules, entities, value objects
//   src/usecase         — application orchestration
//   src/infrastructure  — DB drivers, external APIs, file I/O
//   src/presentation    — controllers and HTTP wiring
//
// 0003 ships the NullAdapter as the default. 0004 will replace
// DATABASE_ADAPTER's useClass / useFactory with the Postgres adapter
// without touching controllers or use cases.

// One configured provider becomes one live client. The switch is
// exhaustive over `AiProviderKind`: adding a kind to KNOWN_KINDS in
// bootstrap/ai-providers.config.ts without adding a branch here fails
// to compile on the `never` assignment, which is the point of keeping
// the kinds a union rather than a string.
//
// The `as unknown as AnthropicClient` cast adapts the SDK's overloaded
// `messages.create` to the narrow non-streaming slice the provider
// depends on (see anthropic-provider.ts for why the structural
// assertion lives at the wiring seam).
function buildEntry(entry: AiProviderConfigEntry): AiProviderEntry {
  switch (entry.kind) {
    case "anthropic": {
      const client = new Anthropic({ apiKey: entry.apiKey });
      return {
        id: entry.id,
        name: entry.name,
        kind: entry.kind,
        model: entry.model,
        provider: new AnthropicProvider(client as unknown as AnthropicClient, entry.model),
      };
    }
    default: {
      const unreachable: never = entry.kind;
      throw new Error(`unsupported AI provider kind: ${String(unreachable)}`);
    }
  }
}

@Module({
  controllers: [
    HealthController,
    TablesController,
    CapabilitiesController,
    QueryController,
    ConnectionsController,
    ConnectionTablesController,
    ConnectionCapabilitiesController,
    ConnectionSchemaController,
    ConnectionRowsController,
    ConnectionDumpController,
    ConnectionRestoreController,
    HistoryController,
    AiController,
  ],
  providers: [
    { provide: DATABASE_ADAPTER, useClass: NullAdapter },
    { provide: CONNECTION_REGISTRY, useClass: InMemoryConnectionRegistry },
    { provide: ADAPTER_FACTORY, useClass: StaticAdapterFactory },
    GetHealth,
    {
      provide: ListTables,
      useFactory: (adapter: NullAdapter) => new ListTables(adapter),
      inject: [DATABASE_ADAPTER],
    },
    {
      provide: GetCapabilities,
      useFactory: (adapter: NullAdapter) => new GetCapabilities(adapter),
      inject: [DATABASE_ADAPTER],
    },
    {
      provide: ExecuteQuery,
      useFactory: (adapter: NullAdapter, registry: InMemoryConnectionRegistry) =>
        new ExecuteQuery(adapter, registry),
      inject: [DATABASE_ADAPTER, CONNECTION_REGISTRY],
    },
    {
      provide: ListConnectionTables,
      useFactory: (adapter: NullAdapter, registry: InMemoryConnectionRegistry) =>
        new ListConnectionTables(adapter, registry),
      inject: [DATABASE_ADAPTER, CONNECTION_REGISTRY],
    },
    {
      provide: DescribeTable,
      useFactory: (adapter: NullAdapter, registry: InMemoryConnectionRegistry) =>
        new DescribeTable(adapter, registry),
      inject: [DATABASE_ADAPTER, CONNECTION_REGISTRY],
    },
    {
      provide: DumpDatabase,
      useFactory: (adapter: NullAdapter, registry: InMemoryConnectionRegistry) =>
        new DumpDatabase(adapter, registry),
      inject: [DATABASE_ADAPTER, CONNECTION_REGISTRY],
    },
    // The write-side counterpart of DumpDatabase (ticket 0030). Same
    // per-request resolution: a restore always runs on the adapter the
    // connection currently holds.
    {
      provide: RestoreDatabase,
      useFactory: (adapter: NullAdapter, registry: InMemoryConnectionRegistry) =>
        new RestoreDatabase(adapter, registry),
      inject: [DATABASE_ADAPTER, CONNECTION_REGISTRY],
    },
    // The one write path (ticket 0028). Resolved per request like every
    // other scoped use case, so an edit always runs on the adapter the
    // connection currently holds — never one cached across a rebuild
    // (ticket 0027).
    {
      provide: UpdateRow,
      useFactory: (adapter: NullAdapter, registry: InMemoryConnectionRegistry) =>
        new UpdateRow(adapter, registry),
      inject: [DATABASE_ADAPTER, CONNECTION_REGISTRY],
    },
    {
      provide: GetConnectionCapabilities,
      useFactory: (adapter: NullAdapter, registry: InMemoryConnectionRegistry) =>
        new GetConnectionCapabilities(adapter, registry),
      inject: [DATABASE_ADAPTER, CONNECTION_REGISTRY],
    },
    {
      provide: RegisterConnection,
      useFactory: (registry: InMemoryConnectionRegistry, factory: StaticAdapterFactory) =>
        new RegisterConnection(registry, factory),
      inject: [CONNECTION_REGISTRY, ADAPTER_FACTORY],
    },
    {
      provide: ListConnections,
      useFactory: (registry: InMemoryConnectionRegistry) => new ListConnections(registry),
      inject: [CONNECTION_REGISTRY],
    },
    {
      provide: DeleteConnection,
      useFactory: (registry: InMemoryConnectionRegistry) => new DeleteConnection(registry),
      inject: [CONNECTION_REGISTRY],
    },
    {
      provide: UpdateConnection,
      useFactory: (registry: InMemoryConnectionRegistry, factory: StaticAdapterFactory) =>
        new UpdateConnection(registry, factory),
      inject: [CONNECTION_REGISTRY, ADAPTER_FACTORY],
    },
    {
      provide: ListDrivers,
      useFactory: (factory: StaticAdapterFactory) => new ListDrivers(factory),
      inject: [ADAPTER_FACTORY],
    },
    { provide: SSH_HOST_KEY_PROBE, useClass: SshHostKeyProber },
    {
      provide: ProbeSshHostKey,
      useFactory: (probe: SshHostKeyProber) => new ProbeSshHostKey(probe),
      inject: [SSH_HOST_KEY_PROBE],
    },
    { provide: HISTORY_STORE, useClass: InMemoryHistoryStore },
    // AI providers (Phase 6 Slice 1, widened to a registry by ticket
    // 0032 slice B). The list comes from the environment and is fixed
    // for the life of the process; an empty registry is the disabled
    // deployment, and it still boots — CLAUDE.md rule 4.
    //
    // A misconfigured list throws here, during startup, rather than
    // dropping the offending provider: an operator who mistyped a
    // variable should find out from the process, not from a user who
    // picked the provider that quietly went missing.
    {
      provide: AI_PROVIDER_REGISTRY,
      useFactory: (): AiProviderRegistry => {
        const config = readAiProvidersConfig(process.env);
        return new StaticAiProviderRegistry(config.entries.map(buildEntry), config.defaultId);
      },
    },
    // The three AI use cases share the registry. It is not optional:
    // "no provider" is a state the registry represents (an empty list),
    // not an absent dependency — which is what lets one place decide
    // whether AI is off, instead of each injection site deciding again.
    //
    // `RecordHistory` is injected too: since history v:2 (ticket 0023)
    // AI calls are recorded alongside SQL calls, and a provider-less
    // deployment still resolves this fine because the recorder is only
    // reached once a provider has answered.
    {
      provide: ExplainSql,
      useFactory: (registry: AiProviderRegistry, history: RecordHistory) =>
        new ExplainSql(registry, history),
      inject: [AI_PROVIDER_REGISTRY, RecordHistory],
    },
    {
      provide: SuggestSql,
      useFactory: (registry: AiProviderRegistry, history: RecordHistory) =>
        new SuggestSql(registry, history),
      inject: [AI_PROVIDER_REGISTRY, RecordHistory],
    },
    {
      provide: ListAiProviders,
      useFactory: (registry: AiProviderRegistry) => new ListAiProviders(registry),
      inject: [AI_PROVIDER_REGISTRY],
    },
    {
      provide: RecordHistory,
      useFactory: (store: HistoryStore) => new RecordHistory(store),
      inject: [HISTORY_STORE],
    },
    {
      provide: ExportHistory,
      useFactory: (store: HistoryStore) => new ExportHistory(store),
      inject: [HISTORY_STORE],
    },
    HistoryRecordingInterceptor,
  ],
})
export class AppModule {}
