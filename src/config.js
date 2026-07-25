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

function envFloat(name, fallback)
{
    const v = process.env[name];
    if (v == null || v === '')
        return fallback;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
}

// Comma-separated floats, e.g. TELEPORT_AVATAR_SUBSCENE_POSITION="1.5,0,-2".
function envFloatList(name, fallback)
{
    const v = process.env[name];
    if (v == null || v === '')
        return fallback;
    const parts = String(v).split(',').map(s => parseFloat(s.trim()));
    return parts.every(Number.isFinite) ? parts : fallback;
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
            formats : envList('TELEPORT_AVATARS_FORMATS', [ 'glb', 'vrm' ]),
            max_file_bytes : envInt('TELEPORT_AVATARS_MAX_FILE_BYTES', 8_000_000),
        },
        // Proof block — phase 2 never demands a proof.
        proof : {
            required : envBool('TELEPORT_AVATARS_PROOF_REQUIRED', false),
            accepted_schemes : envList('TELEPORT_AVATARS_PROOF_SCHEMES', []),
        },
        // Phase 3: when true, install a DefaultAvatarValidator on each
        // client so offered URLs are actually fetched, hashed and
        // measured. When false (the default) the AvatarService keeps its
        // Phase-2 behaviour and always replies using_default.
        validate : envBool('TELEPORT_AVATARS_VALIDATE', false),
        // Hard wall-clock budget on the entire fetch+hash step. Mirrors
        // the policy.fetch_timeout_ms field on the wire.
        fetch_timeout_ms : envInt('TELEPORT_AVATARS_FETCH_TIMEOUT_MS', 15000),
        // Server-provided avatar: spawn one node per connected client with a
        // MeshComponent whose URL resolves to a VRM under http_resources.
        // The client fetches the VRM and instantiates it as a subscene of the
        // node. Static for now (movement TBD); the node's lifetime is the
        // client's session — it is destroyed, and a RemoveNodes payload sent
        // to remaining clients, when the owning client disconnects.
        subscene : {
            enabled : envBool('TELEPORT_AVATAR_SUBSCENE_ENABLED', true),
            url : process.env.TELEPORT_AVATAR_SUBSCENE_URL || '/generic_avatar.vrm',
            position : envFloatList('TELEPORT_AVATAR_SUBSCENE_POSITION', [ 0, 0, 0 ]),
        },
    },
    // Spatial-audio SFU selection policy, read by src/mic-router.js. The server
    // forwards each participant's microphone to the others on per-source tracks
    // bound to the emitting node (mid = node uid; see docs/protocol/audio.rst).
    audio : {
        // Tell each client to send its microphone track (required for the SFU to
        // receive and forward that client's voice). Default on.
        acceptMicrophone : envBool('TELEPORT_AUDIO_ACCEPT_MIC', true),
        // 'All'       — forward every other participant (default).
        // 'Proximity' — forward the nearest maxInboundStreams within the radius.
        selectionPolicy : process.env.TELEPORT_AUDIO_POLICY || 'All',
        // Per-listener cap on concurrent forwarded voices. 0 = no cap.
        maxInboundStreams : envInt('TELEPORT_AUDIO_MAX_STREAMS', 12),
        // Proximity radius in metres. 0 = no radius limit. Used only by 'Proximity'.
        proximityRadiusMetres : envFloat('TELEPORT_AUDIO_PROXIMITY_RADIUS', 0),
        // Hysteresis (ms) before dropping a source that fell out of the selected
        // set, to avoid churn at the boundary. 0 = evict immediately.
        evictionGraceMs : envInt('TELEPORT_AUDIO_EVICTION_GRACE_MS', 0),
    },
};

module.exports = config;
