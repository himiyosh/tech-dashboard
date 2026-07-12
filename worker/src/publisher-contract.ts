import contractJson from "../publisher-contract.json";

export const PUBLISHER_CONTRACT_PATH = "worker/publisher-contract.json";

interface PublisherContract {
  schemaVersion: number;
  fingerprint: string;
  criticalPaths: string[];
}

const FINGERPRINT_RE = /^sha256:[a-f0-9]{64}$/;

function validatePublisherContract(value: unknown, label: string): PublisherContract {
  if (!value || typeof value !== "object") {
    throw new Error(`${label} publisher contract must be an object`);
  }

  const contract = value as Partial<PublisherContract>;
  if (contract.schemaVersion !== 1) {
    throw new Error(`${label} publisher contract has unsupported schemaVersion ${String(contract.schemaVersion)}`);
  }
  if (typeof contract.fingerprint !== "string" || !FINGERPRINT_RE.test(contract.fingerprint)) {
    throw new Error(`${label} publisher contract has an invalid fingerprint`);
  }
  if (
    !Array.isArray(contract.criticalPaths) ||
    contract.criticalPaths.length === 0 ||
    contract.criticalPaths.some((path) => typeof path !== "string" || path.length === 0)
  ) {
    throw new Error(`${label} publisher contract has invalid criticalPaths`);
  }

  return contract as PublisherContract;
}

const deployedContract = validatePublisherContract(contractJson, "deployed");

export const DEPLOYED_PUBLISHER_FINGERPRINT = deployedContract.fingerprint;

export function parsePublisherContractContent(content: string, label = "repository"): PublisherContract {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} publisher contract is invalid JSON: ${reason}`);
  }
  return validatePublisherContract(parsed, label);
}

export function assertPublisherContractContent(content: string): string {
  const repositoryContract = parsePublisherContractContent(content);
  if (JSON.stringify(repositoryContract.criticalPaths) !== JSON.stringify(deployedContract.criticalPaths)) {
    throw new Error("publisher contract criticalPaths differ from the deployed runtime");
  }
  if (repositoryContract.fingerprint !== DEPLOYED_PUBLISHER_FINGERPRINT) {
    throw new Error(
      `publisher contract mismatch: deployed ${DEPLOYED_PUBLISHER_FINGERPRINT}, repository ${repositoryContract.fingerprint}; deploy tech-dashboard-harness before publishing data`,
    );
  }
  return repositoryContract.fingerprint;
}
