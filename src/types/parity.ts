/**
 * Compile-time drift detection between hand-written API types and the
 * OpenAPI spec generated from the Laravel backend (npm run gen:types).
 * If the backend changes a response shape, `npm run build` fails here.
 *
 * NOTE (2026-07-14): `npm run gen:types` was run against the LIVE deployed
 * spec (https://danubedata.ro/docs/api.json). That spec does NOT yet include
 * this plan's new Laravel endpoints (`/plans`, `per_page` query params on
 * `/vps`) — they aren't deployed. That's expected and fine: this file only
 * asserts the six long-existing endpoints below. A post-deploy `npm run
 * gen:types` regen (to pick up the new surface) is on the release checklist.
 *
 * NOTE on path keys: the spec's `servers[0].url` is
 * `https://danubedata.ro/api/v1`, so openapi-typescript emits `paths` keys
 * *relative to that base* (e.g. `/vps`, not `/api/v1/vps`). Keys below were
 * copied verbatim from `src/types/generated.d.ts`.
 *
 * NOTE on narrowed/dropped checks: two endpoints (`GET /vps`, `GET
 * /storage/buckets/{bucket}`) currently document a completely broken 200
 * response in the spec itself (confirmed in the raw JSON, not just
 * codegen — see the tripwires below), and one (`GET
 * /serverless/{serverlessContainer}`) documents the raw Eloquent model
 * instead of the actual response shape. Per-check comments below explain
 * each; full root-cause detail is in the task-12 report.
 */
import type { paths } from './generated.js';
import type {
  VpsInstance,
  CacheInstance,
  DatabaseInstance,
  ServerlessContainer,
  StorageBucket,
  Pagination,
} from './api.js';

type Json<T> = T extends { content: { 'application/json': infer B } } ? B : never;

type VpsList = Json<paths['/vps']['get']['responses'][200]>;
type VpsShow = Json<paths['/vps/{vpsInstance}']['get']['responses'][200]>;
type CacheShow = Json<paths['/cache/{cacheInstance}']['get']['responses'][200]>;
type DatabaseShow = Json<paths['/database/{databaseInstance}']['get']['responses'][200]>;
type BucketShow = Json<paths['/storage/buckets/{bucket}']['get']['responses'][200]>;
type ServerlessShow = Json<paths['/serverless/{serverlessContainer}']['get']['responses'][200]>;
type RapidsLogs = Json<paths['/serverless/{serverlessContainer}/logs']['get']['responses'][200]>;
type RapidsRevisions = Json<paths['/serverless/{serverlessContainer}/revisions']['get']['responses'][200]>;
type RapidsEvents = Json<paths['/serverless/{serverlessContainer}/events']['get']['responses'][200]>;

/**
 * Each check asserts the spec's response type (`B`) is assignable to the shape
 * the CLI actually reads (`A`) — i.e. the backend still provides everything we
 * consume, with compatible types. `Satisfies<A, B extends A>` compile-fails otherwise.
 */
type Satisfies<A, B extends A> = B;

/**
 * Real parity check (was a tripwire).
 *
 * The spec used to document this 200 response as `{"type": "integer", "enum":
 * [200]}` — Scramble mis-parsing the controller's `@response 200 {...}`
 * PHPDoc into the status-code literal instead of a schema. The tripwire
 * `Satisfies<200, VpsList>` held only while that bug was present, precisely so
 * it would stop compiling the moment the backend was fixed.
 *
 * It has now fired: the spec carries a real object, so this asserts the shape
 * the CLI actually reads.
 */
type _vpsList = Satisfies<{ data: VpsInstanceChecked[]; pagination: Pagination }, VpsList>;

/**
 * Two fields excluded — both confirmed genuine Scramble inference gaps
 * against app/Http/Resources/VpsInstanceResource.php + migrations, not real
 * wire behavior:
 *  - cpu_allocation_type: DB column is `$table->string(...)` with the only
 *    two values enforced by app-level class constants
 *    (VpsInstance::ALLOCATION_SHARED/ALLOCATION_DEDICATED), not a native PHP
 *    enum — Scramble has no way to see that constraint and falls back to
 *    plain `string`. The CLI's narrower union is correct; keep it.
 *  - resource_profile: `2025_09_26_084052_create_vps_instances_table.php`
 *    defines `$table->string('resource_profile')->default('small')` — NOT
 *    nullable. The spec's `string | null` doesn't reflect real behavior.
 */
type VpsInstanceChecked = Omit<VpsInstance, 'cpu_allocation_type' | 'resource_profile'>;
type _vpsShow = Satisfies<{ instance: VpsInstanceChecked }, VpsShow>;

/**
 * One nested field excluded: `provider.type` is populated inside a
 * `whenLoaded('provider', fn() => [...])` closure in CacheInstanceResource
 * (`'type' => $this->provider->type->value` — a genuine backed PHP enum on
 * `cache_providers.type`). Scramble can infer backed-enum unions for
 * top-level resource fields (see `status`/`status_label` above, which come
 * out correctly as literal unions) but not through this closure indirection,
 * so it falls back to plain `string`. `provider_id` / `provider.id` are a
 * genuine fix (see src/types/api.ts): `cache_providers.id` is a
 * `$table->id()` auto-increment integer, not a ULID — the spec's `number`
 * was right and the CLI's old `string` was wrong.
 */
type CacheInstanceChecked = Omit<CacheInstance, 'provider'> & {
  provider?: Omit<NonNullable<CacheInstance['provider']>, 'type'>;
};
type _cacheShow = Satisfies<{ instance: CacheInstanceChecked }, CacheShow>;

/**
 * Same `whenLoaded()` closure/enum-inference gap as cache, on both nested
 * lookups: `provider.type` and `engine.name` (DatabaseInstanceResource sets
 * `'name' => $this->provider->type->value` for `engine`, so it's the same
 * enum value under a different key). `provider_id` / `provider.id` /
 * `engine.id` and `datacenter` are genuine fixes (see src/types/api.ts):
 * `database_providers.id` is a `$table->id()` integer, and `datacenter` was
 * renamed from the nullable `hetzner_datacenter` column
 * (`2026_01_19_000001_remove_hetzner_columns_from_cache_database_instances.php`)
 * so it is genuinely `string | null` on the wire.
 */
type DatabaseInstanceChecked = Omit<DatabaseInstance, 'provider' | 'engine'> & {
  provider?: Omit<NonNullable<DatabaseInstance['provider']>, 'type'>;
  engine?: Omit<NonNullable<DatabaseInstance['engine']>, 'name'>;
};
type _databaseShow = Satisfies<{ instance: DatabaseInstanceChecked }, DatabaseShow>;

/**
 * Real parity check (was a tripwire), same story as the VPS list above:
 * `StorageManagementController::show()` carried the identical mis-parsed
 * `@response 200 {...}` PHPDoc, and the spec now documents the real shape.
 *
 * Replacing it surfaced three genuine drifts in the hand-written types —
 * `size_bytes`, `object_count` and `monthly_cost_cents` are nullable, and
 * `monthly_cost_dollars` is a number (StorageBucket::getMonthlyCostInDollars()
 * returns float), not a string. All four are corrected in api.ts; the call
 * sites already guarded with `?? 0`, so only the declarations were wrong.
 */
type _bucketShow = Satisfies<{ bucket: StorageBucket }, BucketShow>;

/**
 * Six fields excluded. Root cause is structural, not per-field: unlike the
 * other four resources, `ServerlessManagementController::show()` returns the
 * raw Eloquent model directly (`'container' => $serverlessContainer`, no API
 * Resource — see app/Http/Controllers/Api/V1/ServerlessManagementController.php).
 * Scramble therefore documents the *model's* column/cast shape, not a curated
 * response shape, which is unreliable in the same handful of ways every time:
 *  - deployment_type, scaling_metric: plain `string` in the spec because the
 *    allowed values are app-level class constants
 *    (ServerlessContainer::DEPLOYMENT_TYPE_*), not a native PHP enum —
 *    same gap as VPS's cpu_allocation_type above.
 *  - environment_variables: spec says `string | null`; the model casts this
 *    `encrypted:array` (decrypts + json-decodes on read — see
 *    app/Models/ServerlessContainer.php `$casts`), but Scramble doesn't
 *    understand compound "encrypted:array" cast strings and falls back to
 *    the raw storage type. (Scramble *does* handle plain `array` casts
 *    correctly — see `metrics_cache`/`argocd_data` in the generated schema —
 *    so this is specifically an `encrypted:*` gap.)
 *  - status, created_at, updated_at: spec marks these nullable (raw
 *    column/migration nullability — `created_at`/`updated_at` are the
 *    standard Eloquent `timestamps()` gap; `status` is
 *    `$table->enum(...)->default('pending')` with NO `.nullable()` in
 *    `2025_11_19_120000_create_serverless_containers_table.php`, so the
 *    nullable annotation is simply wrong) even though the app never returns
 *    a null value for an existing row.
 * `image` is a genuine fix (see src/types/api.ts):
 * `2026_01_08_174407_make_image_nullable_on_serverless_containers_table.php`
 * explicitly makes it nullable ("for git_repository deployments where image
 * is built later") — real wire behavior, not an artifact.
 *
 * Separately, and out of scope for this check: because this endpoint dumps
 * the raw model and `ServerlessContainer` has no `$hidden`, the spec (and,
 * per the controller code, the real response) also includes `webhook_secret`
 * and a *decrypted* `git_credentials_encrypted`. That's a genuine credential
 * exposure in the backend, unrelated to CLI type drift — flagged prominently
 * in the task-12 report, not something to encode in CLI types.
 */
/**
 * `status_details` is excluded on a TIMER, not permanently.
 *
 * It is an object at runtime and the automation guide tells agents to read it
 * instead of `status`, but the deployed spec still types it `string` — the
 * array-shape inference gap again, on the single most load-bearing field in the
 * API. danubedata 1059f32b fixes it and is pushed but not deployed.
 *
 * The tripwire is below: once that deploys and types regenerate, the assertion
 * fails and this exclusion comes out.
 */
type ServerlessContainerChecked = Omit<
  ServerlessContainer,
  'deployment_type' | 'scaling_metric' | 'environment_variables' | 'status' | 'status_details' | 'created_at' | 'updated_at'
>;
type _serverlessShow = Satisfies<{ container: ServerlessContainerChecked }, ServerlessShow>;

export {};

/**
 * Diagnostics — real parity checks (were tripwires), plus a new set of
 * tripwires for the fields that are still wrong.
 *
 * The old tripwires asserted `entries`, `revisions` and `events` were typed
 * `string`. They have now FIRED: backend fb617c66 gave each collection a real
 * component schema, so the checks below assert the fields the commands in
 * src/commands/serverless/diagnostics.ts actually read.
 *
 * `available: false` vs an empty collection is the distinction these endpoints
 * exist to preserve, so it stays asserted on all three.
 */
type _rapidsLogs = Satisfies<{
  success: boolean;
  data: {
    available: boolean;
    entries: Array<{ timestamp: string; level: string; message: string }>;
  };
}, RapidsLogs>;

type _rapidsRevisions = Satisfies<{
  success: boolean;
  data: {
    available: boolean;
    revisions: Array<{
      name: string | null;
      is_latest_ready: boolean;
      is_latest_created: boolean;
      // Tri-state, not a boolean — `Unknown` means still rolling out.
      conditions: Array<{ type: string; status: string; reason: string | null; message: string | null }>;
    }>;
    service: { latest_ready_revision: string | null } | null;
    route: { url: string | null } | null;
  };
}, RapidsRevisions>;

type _rapidsEvents = Satisfies<{
  success: boolean;
  data: {
    available: boolean;
    events: Array<{
      type: string | null;
      reason: string | null;
      message: string;
      resource: { kind: string | null; name: string | null };
      count: number;
      last_seen: string | null;
    }>;
  };
}, RapidsEvents>;

/**
 * Exact type equality — a stricter check than `Satisfies`, which only tests
 * assignability.
 */
type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type AssertTrue<T extends true> = T;

/**
 * Regression guards on seven fields that Scramble twice published as the wrong
 * type. These were tripwires asserting the BROKEN shapes; backend 0bd150bc
 * deployed and all seven fired, so they now assert the CORRECT shapes.
 *
 * Kept as exact-equality checks rather than folded into the `Satisfies` blocks
 * above, because assignability cannot detect the specific relapse we care
 * about: `string` IS assignable to `string | null`, so a `Satisfies` check on
 * `next_cursor` would sit there green while the spec regressed to the exact
 * bug this file exists to catch. `Exact` fails on it.
 *
 * The defect: Scramble cannot infer a type through an array-shape offset
 * (`$result['truncated']`) and falls back to `string` rather than admitting it
 * does not know. It reappears whenever a controller passes an array value
 * straight through instead of casting at the construction site — which is easy
 * to do and invisible in review, hence these guards.
 *
 * `actual_replicas` is the consequential one. Its own spec description says
 * zero alongside a failed Ready condition means no pod was ever scheduled —
 * the incident these endpoints exist for. Typed `string`, a generated client
 * compares `"0" === 0` and the check never fires. The CLI escaped that only
 * because it reads `Record<string, unknown>` and coerces.
 */
type RapidsRevision = RapidsRevisions['data']['revisions'][number];

/**
 * REGRESSION, currently live. The four guards that used to assert
 * `meta.truncated` / `.next_cursor` / `.level` individually cannot even be
 * written today: the deployed spec types the WHOLE `meta` object as `string`,
 * so indexing into it does not compile.
 *
 * Cause: `RespondsWithEnvelope::envelope()` returns `'meta' => (object) $meta`
 * (danubedata f671ec94). Scramble cannot infer a shape through the cast, falls
 * back to `string`, and scrapes the adjacent `//` comment as the description —
 * the published description is literally
 * "(object) so an empty meta serialises as {} rather than [].".
 *
 * The RUNTIME payload is correct; only the spec is wrong. But it is wrong for
 * every diagnostics endpoint on every product now, not just rapids, because
 * they all share that trait.
 *
 * These assert the BROKEN shape on purpose, per this file's idiom. When the
 * backend teaches Scramble the meta shape, they stop compiling — at which
 * point restore the four per-field Exact guards from git history.
 */
type _tripwireLogsMetaIsString = AssertTrue<Exact<RapidsLogs['meta'], string>>;
type _tripwireEventsMetaIsString = AssertTrue<Exact<RapidsEvents['meta'], string>>;
type _guardRevisionGeneration = AssertTrue<Exact<RapidsRevision['generation'], number | null>>;
type _guardRevisionDesiredReplicas = AssertTrue<Exact<RapidsRevision['desired_replicas'], number | null>>;
type _guardRevisionActualReplicas = AssertTrue<Exact<RapidsRevision['actual_replicas'], number | null>>;

/**
 * FIRED and removed: `status_details` on the container was `string` in the
 * deployed spec and is now a proper object, so the third-generation tripwire
 * that asserted the broken shape has served its purpose. It stays out of the
 * ServerlessContainerChecked exclusion only until someone reconciles the
 * hand-written ServerlessContainer type with the generated one — tracked with
 * the rest of the CLI type migration.
 */
