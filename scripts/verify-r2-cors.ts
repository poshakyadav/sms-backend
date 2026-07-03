// scripts/verify-r2-cors.ts
// Run manually or in CI after `infra:apply-cors` to confirm the policy is
// actually live — catches typos in the JSON or a policy that didn't save.

/**
 * 
 * Run with npx tsx scripts/verify-r2-cors.ts after every infra:apply-cors, or wire it into CI right after deploy — it would have caught this entire multi-day debugging session in about 200 milliseconds.
 */

const CHECKS = [
    {
        name: "school-user-avatars (localhost)",
        url: "https://pub-28618fa12fce4345be3832ea3c68a1c1.r2.dev/avatars/1/3/5cc036c3-0636-4ea7-a2e7-b2ce89b97930.webp",
        origin: "http://localhost:4200",
    },
    {
        name: "school-user-avatars (eduxo.net)",
        url: "https://pub-28618fa12fce4345be3832ea3c68a1c1.r2.dev/avatars/1/3/5cc036c3-0636-4ea7-a2e7-b2ce89b97930.webp",
        origin: "https://eduxo.net",
    },
];

async function main() {
    for (const check of CHECKS) {
        const res = await fetch(check.url, {
            headers: { Origin: check.origin },
        });
        const cors = res.headers.get("access-control-allow-origin");
        if (!cors) {
            console.error(`❌ ${check.name}: NO CORS header present`);
            process.exitCode = 1;
        } else {
            console.log(`✅ ${check.name}: CORS OK (${cors})`);
        }
    }
}

main();