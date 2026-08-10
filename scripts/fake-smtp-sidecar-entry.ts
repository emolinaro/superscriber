/**
 * Container sidecar entry: runs the canonical fake SMTP provider (see
 * e2e/support/fake-smtp.ts) with plain node after esbuild bundling in
 * scripts/run-e2e-appliance.sh, mirroring fake-oidc-sidecar-entry.ts.
 */
import { startFakeSmtpServers } from "../e2e/support/fake-smtp";

const smtpPort = Number(process.argv[2] || 4205);
const controlPort = Number(process.argv[3] || 4206);

startFakeSmtpServers(smtpPort, controlPort);
console.log(`fake smtp on ${smtpPort}, control on ${controlPort}`);
