/**
 * Managed Kafka specifics for `danube queue`: provider/plan validation and the
 * connection snippets. Kept apart from the command wiring so it can be tested
 * without the API client.
 */

export const QUEUE_PROVIDERS = ['rabbitmq', 'kafka'] as const;
export type QueueProvider = (typeof QUEUE_PROVIDERS)[number];

export const KAFKA_PLAN_PREFIX = 'kafka-';

export function isQueueProvider(value: string): value is QueueProvider {
  return (QUEUE_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Returns an error message when the provider and plan slug cannot go together,
 * otherwise null. The API stays the authority on which slugs exist; this only
 * catches the mix-up of a Kafka plan with RabbitMQ (or the reverse) before a
 * round trip.
 */
export function planProblem(provider: QueueProvider, profile: string): string | null {
  const isKafkaPlan = profile.startsWith(KAFKA_PLAN_PREFIX);
  if (provider === 'kafka' && !isKafkaPlan) {
    return `"${profile}" is not a Kafka plan. Use a kafka-* plan, e.g. kafka-small, kafka-medium or kafka-large.`;
  }
  if (provider === 'rabbitmq' && isKafkaPlan) {
    return `"${profile}" is a Kafka plan. Add --provider kafka to create a Kafka cluster.`;
  }
  return null;
}

export interface KafkaConnectionInfo {
  status?: string | null;
  certificate?: string | null;
  bootstrap_servers?: string | null;
  security_protocol?: string | null;
  sasl_mechanism?: string | null;
  username?: string | null;
  password?: string | null;
  schema_registry?: {
    status?: string | null;
    url?: string | null;
    username?: string | null;
    password?: string | null;
  } | null;
}

export function isKafkaConnectionInfo(info: Record<string, unknown>): boolean {
  return info.provider === 'kafka' || 'bootstrap_servers' in info;
}

/** Snippets never embed the password: it would land in shell history, scrollback and pasted tickets. */
export const PASSWORD_ENV_VAR = 'KAFKA_PASSWORD';
const PASSWORD_PLACEHOLDER = '<password>';

/** Single-quote for a POSIX shell. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function kcatSnippet(info: KafkaConnectionInfo): string {
  return [
    `kcat -L -b ${shellQuote(info.bootstrap_servers ?? '')}`,
    `-X security.protocol=${info.security_protocol ?? 'SASL_SSL'}`,
    `-X sasl.mechanisms=${info.sasl_mechanism ?? 'SCRAM-SHA-512'}`,
    `-X sasl.username=${shellQuote(info.username ?? '')}`,
    `-X sasl.password="$${PASSWORD_ENV_VAR}"`,
  ].join(' \\\n  ');
}

/**
 * The password is a placeholder, not an escaped value: java.util.Properties
 * strips backslashes before JAAS parses the line, so a real password needs two
 * escaping layers, and pasting it in by hand avoids getting that wrong.
 */
export function javaPropertiesSnippet(info: KafkaConnectionInfo): string {
  return [
    `bootstrap.servers=${info.bootstrap_servers ?? ''}`,
    `security.protocol=${info.security_protocol ?? 'SASL_SSL'}`,
    `sasl.mechanism=${info.sasl_mechanism ?? 'SCRAM-SHA-512'}`,
    `sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username="${info.username ?? ''}" password="${PASSWORD_PLACEHOLDER}";`,
  ].join('\n');
}
