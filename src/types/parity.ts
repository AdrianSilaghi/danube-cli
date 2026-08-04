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
type ServerlessContainerChecked = Omit<
  ServerlessContainer,
  'deployment_type' | 'scaling_metric' | 'environment_variables' | 'status' | 'created_at' | 'updated_at'
>;
type _serverlessShow = Satisfies<{ container: ServerlessContainerChecked }, ServerlessShow>;

export {};

/**
 * Diagnostics envelope — partial check plus a tripwire.
 *
 * The envelope itself (`success`, `data.available`) is documented correctly and
 * is asserted below, because `available: false` vs an empty collection is the
 * distinction these endpoints exist to preserve.
 *
 * The COLLECTIONS are not: Scramble types `entries`, `revisions` and `events`
 * as `string` rather than arrays, because the controller returns
 * `array<string, mixed>` and there is nothing for it to infer an item shape
 * from. Runtime is unaffected — the commands read their own `Envelope<T>` —
 * but the published spec currently misdescribes them, which matters precisely
 * because these endpoints exist for agents reading that spec.
 *
 * Same tripwire pattern as the VPS/bucket checks above: asserting the broken
 * `string` shape means this stops compiling the moment the backend annotates
 * the item types, which is the signal to replace it with a real check.
 */
type _rapidsLogsEnvelope = Satisfies<{ success: boolean; data: { available: boolean } }, RapidsLogs>;
type _rapidsRevisionsEnvelope = Satisfies<{ success: boolean; data: { available: boolean } }, RapidsRevisions>;
type _rapidsEventsEnvelope = Satisfies<{ success: boolean; data: { available: boolean } }, RapidsEvents>;

type _rapidsLogsEntriesSpecArtifactTripwire = Satisfies<string, RapidsLogs['data']['entries']>;
type _rapidsRevisionsSpecArtifactTripwire = Satisfies<string, RapidsRevisions['data']['revisions']>;
type _rapidsEventsSpecArtifactTripwire = Satisfies<string, RapidsEvents['data']['events']>;
