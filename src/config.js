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

// Parse a JSON-valued variable. A malformed value is loud but not fatal: the
// server starts with the fallback rather than refusing to boot, and the
// operator sees why in the log.
function envJson(name, fallback)
{
    const v = process.env[name];
    if (v == null || v === '')
        return fallback;
    try
    {
        return JSON.parse(v);
    }
    catch (err)
    {
        console.warn('config: ' + name + ' is not valid JSON (' + err.message +
                     '); using the default.');
        return fallback;
    }
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
        // Phase 5: on by default. The negotiated flow validates offered
        // avatars, imports them (or the default) as scene nodes, and
        // streams them to every peer. Set TELEPORT_AVATARS_ENABLED=0 to
        // fall back to the legacy static subscene behaviour.
        enabled : envBool('TELEPORT_AVATARS_ENABLED', true),
        // Mirrors the `requirement` field of avatar-policy:
        //   "optional" — server will accept an offer but does not require it.
        //   "required" — client must offer; default avatar will not be used.
        //   "forbidden" — client must not offer; server will reject offers.
        requirement : process.env.TELEPORT_AVATARS_REQUIREMENT || 'optional',
        // Whether the server will substitute a default avatar when the
        // client offers nothing acceptable. Phase 2 always responds with
        // using_default=true; this flag becomes load-bearing in phase 5.
        default_available : envBool('TELEPORT_AVATARS_DEFAULT_AVAILABLE', true),
        // Relay is the default delivery mode: an accepted avatar's mesh
        // pointer carries the owner's own url, so peers fetch it from the
        // avatar host and we serve none of the bytes. The trade-off is
        // that the url is then visible to every other client — set this
        // to 0 for deployments where the url is itself a secret, and the
        // server will re-host every avatar instead. Individual clients can
        // opt out per-avatar with "allow_relay": false on their offer.
        allow_relay : envBool('TELEPORT_AVATARS_ALLOW_RELAY', true),
        // Free-form requirements bag forwarded verbatim in the policy.
        // Snake_case to match the protocol doc (signaling.rst §Avatar
        // negotiation) so values round-trip without renaming. The
        // measurement keys below are enforced by the validator's glTF
        // parse when `validate` is on.
        requirements : Object.assign(
            {
                formats : envList('TELEPORT_AVATARS_FORMATS', [ 'glb', 'vrm' ]),
                max_file_bytes : envInt('TELEPORT_AVATARS_MAX_FILE_BYTES', 8_000_000),
                max_triangles : envInt('TELEPORT_AVATARS_MAX_TRIANGLES', 80_000),
                max_height_m : envFloat('TELEPORT_AVATARS_MAX_HEIGHT_M', 2.5),
                // Width is the larger horizontal AABB extent; a T-posed
                // humanoid's arm span is roughly its height, so this must
                // not be tighter than max_height_m.
                max_width_m : envFloat('TELEPORT_AVATARS_MAX_WIDTH_M', 2.5),
                max_textures : envInt('TELEPORT_AVATARS_MAX_TEXTURES', 8),
                max_texture_pixels : envInt('TELEPORT_AVATARS_MAX_TEXTURE_PIXELS', 1_048_576),
            },
            // Optional keys are only included when configured, since the
            // bag is forwarded verbatim and their presence changes what
            // the validator enforces (unset means "not restricted").
            process.env.TELEPORT_AVATARS_LICENCE_TAGS
                ? {licence_tags_allowed : envList('TELEPORT_AVATARS_LICENCE_TAGS', [])}
                : {},
            process.env.TELEPORT_AVATARS_SKELETON
                ? {skeleton : process.env.TELEPORT_AVATARS_SKELETON}
                : {}),
        // Proof block — phase 2 never demands a proof.
        proof : {
            required : envBool('TELEPORT_AVATARS_PROOF_REQUIRED', false),
            accepted_schemes : envList('TELEPORT_AVATARS_PROOF_SCHEMES', []),
        },
        // Phase 3: when true (the default since phase 5), install a
        // DefaultAvatarValidator on each client so offered URLs are
        // actually fetched, hashed and measured. When false the
        // AvatarService always replies using_default.
        validate : envBool('TELEPORT_AVATARS_VALIDATE', true),
        // Phase 5: server-relative URL of the default avatar used for
        // using_default results. Served from http_resources; imported
        // lazily the first time a client needs it.
        //
        // The default is the MIT-licensed placeholder generated by
        // tools/make-placeholder-avatar.js. It is deliberately NOT
        // generic_avatar.vrm: that asset's own VRM metadata declares
        // licenseName "Redistribution_Prohibited" and allowedUserName
        // "OnlyAuthor", and serving it to every connecting client is
        // redistribution. Point this at your own licensed asset if you
        // want something better-looking.
        default_url : process.env.TELEPORT_AVATARS_DEFAULT_URL || '/placeholder_avatar.glb',
        // Whether a client is sent its own avatar node as well as its peers'.
        // On by default, which is what a third-person view wants. Turn it off
        // for a first-person client, which would otherwise be looking out from
        // inside its own head.
        send_own_avatar : envBool('TELEPORT_AVATARS_SEND_OWN', true),
        // Hard wall-clock budget on the entire fetch+hash step. Mirrors
        // the policy.fetch_timeout_ms field on the wire.
        fetch_timeout_ms : envInt('TELEPORT_AVATARS_FETCH_TIMEOUT_MS', 15000),
        // Server-provided avatar: spawn one node per connected client with a
        // MeshComponent whose URL resolves to a VRM under http_resources.
        // Legacy path, superseded by the negotiated flow above and only used
        // when `enabled` is false. Note that the bundled generic_avatar.vrm
        // declares licenseName "Redistribution_Prohibited" in its own VRM
        // metadata; substitute your own asset before relying on this.
        // The client fetches the VRM and instantiates it as a subscene of the
        // node. Static for now (movement TBD); the node's lifetime is the
        // client's session — it is destroyed, and a RemoveNodes payload sent
        // to remaining clients, when the owning client disconnects.
        subscene : {
            enabled : envBool('TELEPORT_AVATAR_SUBSCENE_ENABLED', true),
            url : process.env.TELEPORT_AVATAR_SUBSCENE_URL || '/generic_avatar.vrm',
            position : envFloatList('TELEPORT_AVATAR_SUBSCENE_POSITION', [ 0, 0, 0 ]),
            // Same switch as avatars.send_own_avatar, applied to this legacy
            // path so both behave alike.
            sendOwnAvatar : envBool('TELEPORT_AVATARS_SEND_OWN', true),
        },
    },
    // How connecting clients are recognised as new or returning users.
    //
    // With no issuers configured the server still tells returning users apart,
    // but only on the client's own say-so: `identity` in the connect message is
    // self-asserted, so that tier is good for convenience (remembering an
    // avatar) and nothing else.
    //
    // Configure issuers to get real verification. TELEPORT_IDENTITY_ISSUERS is a
    // JSON array; treat it as sensitive configuration alongside
    // TELEPORT_ICE_SERVERS.
    //
    //   [{"iss":"https://accounts.google.com",
    //     "jwksUri":"https://www.googleapis.com/oauth2/v3/certs",
    //     "audiences":["<desktop-client-id>","<device-client-id>"],
    //     "subjectScope":"public"}]
    //
    // subjectScope matters: 'public' (Google) means one subject per user across
    // every client id, so the desktop and headless clients resolve to the same
    // person. 'pairwise' (Apple, Microsoft Entra) means the subject differs per
    // client id, and the audience becomes part of the user's key.
    identity : {
        issuers : envJson('TELEPORT_IDENTITY_ISSUERS', []),
        // Treat unverified clients as anonymous, remembering nothing about
        // them. Off by default so the reference client — which does not yet
        // send a credential — keeps working.
        requireVerified : envBool('TELEPORT_IDENTITY_REQUIRE_VERIFIED', false),
        // How long to wait for a client to answer an identity challenge before
        // continuing without it.
        challengeTimeoutMs : envInt('TELEPORT_IDENTITY_CHALLENGE_TIMEOUT_MS', 5000),
        // Cap on remembered users, since the store is keyed by client-supplied
        // strings.
        maxUsers : envInt('TELEPORT_IDENTITY_MAX_USERS', 10000),
    },
    // Lifetime of client-specific nodes (a client's origin node, its avatar)
    // after the client has gone. Held rather than destroyed immediately, so a
    // client that drops and reconnects within the window keeps the nodes it
    // already had and its peers see no interruption.
    client : {
        // Grace period for a client the server can recognise on its return,
        // i.e. one with a resolved identity. See config.identity.
        graceMs : envInt('TELEPORT_CLIENT_GRACE_MS', 10000),
        // Grace period for an anonymous client. Zero by default: with no stable
        // identity there is nothing to match a returning client against, so
        // holding its nodes only delays the inevitable.
        anonymousGraceMs : envInt('TELEPORT_CLIENT_GRACE_ANONYMOUS_MS', 0),
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
