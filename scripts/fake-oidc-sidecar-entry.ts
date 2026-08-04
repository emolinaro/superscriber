/**
 * Container sidecar entry: runs the canonical fake OIDC provider (see
 * e2e/support/fake-oidc.ts) with plain node after esbuild bundling in
 * scripts/run-e2e-appliance.sh.
 */
import { startFakeOidcServer } from "../e2e/support/fake-oidc";

const port = Number(process.argv[2] || 4105);

startFakeOidcServer({ port }).then((handle) => {
  console.log(`fake oidc listening at ${handle.issuer}`);
});
