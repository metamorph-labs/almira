import { AlmiraClient } from "./client.js";
import { AlmiraDataClient } from "./data-client.js";
import type { AlmiraDataClientOptions } from "./data-client.js";
import type {
  CapabilitySessionGrant,
  CollectionReference,
  CreateCapabilitySessionRequest,
  MutationOptions,
} from "./types.js";

export interface CapabilityDataClientOptions
  extends Omit<AlmiraDataClientOptions, "capability" | "origin"> {}

export interface CapabilityDataClientSession {
  /** Sensitive grant returned only to the builder backend. Do not persist or log its token. */
  grant: CapabilitySessionGrant;
  /** Capability-only client ready for the browser/mobile audience in the grant. */
  dataClient: AlmiraDataClient;
}

/**
 * Exchanges current builder-workload evidence for one reusable capability and returns a
 * capability-only client. The workload credential is used only by `managementClient`; it is never
 * copied into the returned data client.
 */
export async function createCapabilityDataClient(
  managementClient: AlmiraClient,
  reference: CollectionReference,
  request: CreateCapabilitySessionRequest,
  mutation: MutationOptions,
  dataOptions: CapabilityDataClientOptions = {},
): Promise<CapabilityDataClientSession> {
  const grant = await managementClient.createCapabilitySession(reference, request, mutation);
  return {
    grant,
    dataClient: new AlmiraDataClient({
      ...dataOptions,
      capability: grant.token,
      origin: grant.audience,
    }),
  };
}
