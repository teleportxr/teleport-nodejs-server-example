// SPDX-FileCopyrightText: 2025 Teleport XR Ltd <contact@teleportxr.io>
//
// SPDX-License-Identifier: MIT

// Example-server configuration. Phase 2 of the avatar rollout (see
// plans/avatars_implementation.md §3.4) introduces an `avatars` block
// that is read by src/server.js when a new client is created.
//
// The block is intentionally small. Until phase 5 the feature is gated
// by `avatars.enabled` which defaults to `false`, so existing
// deployments that don't opt in continue to behave exactly as before.
//
// Environment-variable overrides are honoured for the same reason the
// rest of the server reads configuration from env: Heroku and other
// container hosts have no convenient way to edit checked-in files.

function envBool(name, fallback)
{
    const v = process.env[name];
    if (v == null || v === '')
        return fallback;
    const s = String(v).toLowerCase();
    return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function envInt(name, fallback)
{
    const v = process.env[name];
    if (v == null || v === '')
        return fallback;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
}

function envList(name, fallback)
{
    const v = process.env[name];
    if (v == null || v === '')
        return fallback;
    return String(v).split(',').map(s => s.trim()).filter(s => s.length > 0);
}

// Public config object. Anything that controls protocol-level behaviour
// belongs in here; per-deployment knobs (resource URL, ICE servers, TLS
// enforcement, etc.) remain inline in server.js until they too need
// programmatic access.
const config = {
    avatars : {
        // Phase 2 default: disabled. Flipped to true in phase 5 once the
        // server can actually do something useful with an avatar offer.
        enabled : envBool('TELEPORT_AVATARS_ENABLED', false),
        // Mirrors the `requirement` field of avatar-policy:
        //   "optional" — server will accept an offer but does not require it.
        //   "required" — client must offer; default avatar will not be used.
        //   "forbidden" — client must not offer; server will reject offers.
        requirement : process.env.TELEPORT_AVATARS_REQUIREMENT || 'optional',
        // Whether the server will substitute a default avatar when the
        // client offers nothing acceptable. Phase 2 always responds with
        // using_default=true; this flag becomes load-bearing in phase 5.
        default_available : envBool('TELEPORT_AVATARS_DEFAULT_AVAILABLE', true),
        // Free-form requirements bag forwarded verbatim in the policy.
        // Snake_case to match the protocol doc (signaling.rst §Avatar
        // negotiation) so values round-trip without renaming.
        requirements : {
            formats : envList('TELEPORT_AVATARS_FORMATS', [ 'glb' ]),
            max_file_bytes : envInt('TELEPORT_AVATARS_MAX_FILE_BYTES', 8_000_000),
        },
        // Proof block — phase 2 never demands a proof.
        proof : {
            required : envBool('TELEPORT_AVATARS_PROOF_REQUIRED', false),
            accepted_schemes : envList('TELEPORT_AVATARS_PROOF_SCHEMES', []),
        },
    },
};

module.exports = config;
