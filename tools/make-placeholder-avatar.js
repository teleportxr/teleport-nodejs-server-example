// SPDX-FileCopyrightText: 2026 Teleport XR Ltd <contact@teleportxr.io>
//
// SPDX-License-Identifier: MIT

// Generator for the example server's default avatar
// (http_resources/placeholder_avatar.glb, Phase 5 of
// plans/avatars_implementation.md).
//
// The default avatar is served to every client that does not supply an
// acceptable one of its own, so it must be redistributable without
// restriction. Rather than bundle a third-party model, this script
// authors one from scratch: a blocky humanoid built from axis-aligned
// boxes, under the project's own MIT licence. Regenerate with:
//
//     node tools/make-placeholder-avatar.js
//
// Keeping the generator in the repo (rather than only the binary) makes
// the asset's provenance auditable and the geometry easy to adjust.

'use strict';

const fs    = require('node:fs');
const path  = require('node:path');

// Blocky humanoid, Y-up (glTF convention), standing on y=0, arms at the
// sides. Each entry is [centre, halfExtents]. Roughly 1.79 m tall and
// 0.59 m wide, so it passes the example server's default requirements.
const BOXES = [
    // name          centre                    half extents
    [ 'head', [ 0.000, 1.660, 0.000 ], [ 0.105, 0.125, 0.105 ] ],
    [ 'torso', [ 0.000, 1.320, 0.000 ], [ 0.170, 0.230, 0.100 ] ],
    [ 'hips', [ 0.000, 1.000, 0.000 ], [ 0.150, 0.090, 0.100 ] ],
    [ 'armUpperL', [ 0.245, 1.360, 0.000 ], [ 0.050, 0.170, 0.050 ] ],
    [ 'armLowerL', [ 0.245, 1.020, 0.000 ], [ 0.045, 0.170, 0.045 ] ],
    [ 'armUpperR', [ -0.245, 1.360, 0.000 ], [ 0.050, 0.170, 0.050 ] ],
    [ 'armLowerR', [ -0.245, 1.020, 0.000 ], [ 0.045, 0.170, 0.045 ] ],
    [ 'legUpperL', [ 0.090, 0.680, 0.000 ], [ 0.070, 0.230, 0.070 ] ],
    [ 'legLowerL', [ 0.090, 0.270, 0.000 ], [ 0.060, 0.180, 0.060 ] ],
    [ 'legUpperR', [ -0.090, 0.680, 0.000 ], [ 0.070, 0.230, 0.070 ] ],
    [ 'legLowerR', [ -0.090, 0.270, 0.000 ], [ 0.060, 0.180, 0.060 ] ],
    [ 'footL', [ 0.090, 0.030, 0.045 ], [ 0.060, 0.030, 0.115 ] ],
    [ 'footR', [ -0.090, 0.030, 0.045 ], [ 0.060, 0.030, 0.115 ] ],
];

// The six faces of a unit box: outward normal plus the four corner signs
// (in winding order) expressed in local half-extent space.
const FACES = [
    [ [ 0, 0, 1 ], [ [ -1, -1, 1 ], [ 1, -1, 1 ], [ 1, 1, 1 ], [ -1, 1, 1 ] ] ],
    [ [ 0, 0, -1 ], [ [ 1, -1, -1 ], [ -1, -1, -1 ], [ -1, 1, -1 ], [ 1, 1, -1 ] ] ],
    [ [ 1, 0, 0 ], [ [ 1, -1, 1 ], [ 1, -1, -1 ], [ 1, 1, -1 ], [ 1, 1, 1 ] ] ],
    [ [ -1, 0, 0 ], [ [ -1, -1, -1 ], [ -1, -1, 1 ], [ -1, 1, 1 ], [ -1, 1, -1 ] ] ],
    [ [ 0, 1, 0 ], [ [ -1, 1, 1 ], [ 1, 1, 1 ], [ 1, 1, -1 ], [ -1, 1, -1 ] ] ],
    [ [ 0, -1, 0 ], [ [ -1, -1, -1 ], [ 1, -1, -1 ], [ 1, -1, 1 ], [ -1, -1, 1 ] ] ],
];

function buildGeometry()
{
    const positions = [];
    const normals   = [];
    const indices   = [];
    const min       = [ Infinity, Infinity, Infinity ];
    const max       = [ -Infinity, -Infinity, -Infinity ];

    for (const [, centre, half] of BOXES)
    {
        for (const [normal, corners] of FACES)
        {
            const base = positions.length / 3;
            for (const c of corners)
            {
                const p = [
                    centre[0] + c[0] * half[0],
                    centre[1] + c[1] * half[1],
                    centre[2] + c[2] * half[2],
                ];
                positions.push(p[0], p[1], p[2]);
                normals.push(normal[0], normal[1], normal[2]);
                for (let k = 0; k < 3; k++)
                {
                    min[k] = Math.min(min[k], p[k]);
                    max[k] = Math.max(max[k], p[k]);
                }
            }
            // Two triangles per quad, counter-clockwise when seen from
            // outside so face culling keeps the outward side.
            indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        }
    }
    return {positions, normals, indices, min, max};
}

// Pad a buffer to a 4-byte boundary, as GLB chunks and bufferViews require.
function pad4(buf, filler)
{
    const rem = buf.length % 4;
    return rem ? Buffer.concat([ buf, Buffer.alloc(4 - rem, filler) ]) : buf;
}

function build()
{
    const geo           = buildGeometry();

    const positionBytes = Buffer.alloc(geo.positions.length * 4);
    geo.positions.forEach((v, i) => positionBytes.writeFloatLE(v, i * 4));
    const normalBytes = Buffer.alloc(geo.normals.length * 4);
    geo.normals.forEach((v, i) => normalBytes.writeFloatLE(v, i * 4));
    const indexBytes = pad4(Buffer.alloc(geo.indices.length * 2), 0);
    geo.indices.forEach((v, i) => indexBytes.writeUInt16LE(v, i * 2));

    // Floats first so every float bufferView starts 4-byte aligned.
    const bin         = Buffer.concat([ positionBytes, normalBytes, indexBytes ]);
    const vertexCount = geo.positions.length / 3;

    const json        = {
        asset : {
            version : '2.0',
            generator : 'teleportxr placeholder-avatar generator',
            copyright : 'Copyright 2026 Teleport XR Ltd. SPDX-License-Identifier: MIT',
        },
        scene : 0,
        scenes : [ {nodes : [ 0 ]} ],
        nodes : [ {mesh : 0, name : 'PlaceholderAvatar'} ],
        meshes : [ {
            name : 'PlaceholderAvatar',
            primitives :
                [ {attributes : {POSITION : 0, NORMAL : 1}, indices : 2, material : 0, mode : 4} ],
        } ],
        materials : [ {
            name : 'PlaceholderAvatarMaterial',
            pbrMetallicRoughness : {
                baseColorFactor : [ 0.42, 0.48, 0.58, 1.0 ],
                metallicFactor : 0.0,
                roughnessFactor : 0.85,
            },
        } ],
        accessors : [
            {
                bufferView : 0,
                componentType : 5126,
                count : vertexCount,
                type : 'VEC3',
                // min/max are mandatory on POSITION and are what the avatar
                // validator measures height and width from.
                min : geo.min,
                max : geo.max,
            },
            {bufferView : 1, componentType : 5126, count : vertexCount, type : 'VEC3'},
            {bufferView : 2, componentType : 5123, count : geo.indices.length, type : 'SCALAR'},
        ],
        bufferViews : [
            {buffer : 0, byteOffset : 0, byteLength : positionBytes.length, target : 34962},
            {
                buffer : 0,
                byteOffset : positionBytes.length,
                byteLength : normalBytes.length,
                target : 34962
            },
            {
                buffer : 0,
                byteOffset : positionBytes.length + normalBytes.length,
                byteLength : geo.indices.length * 2,
                target : 34963,
            },
        ],
        buffers : [ {byteLength : bin.length} ],
    };

    const jsonChunk = pad4(Buffer.from(JSON.stringify(json)), 0x20);
    const binChunk  = pad4(bin, 0);

    const header    = Buffer.alloc(12);
    header.writeUInt32LE(0x46546C67, 0); // 'glTF'
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);

    const jsonHeader = Buffer.alloc(8);
    jsonHeader.writeUInt32LE(jsonChunk.length, 0);
    jsonHeader.writeUInt32LE(0x4E4F534A, 4); // 'JSON'
    const binHeader = Buffer.alloc(8);
    binHeader.writeUInt32LE(binChunk.length, 0);
    binHeader.writeUInt32LE(0x004E4942, 4); // 'BIN\0'

    return {
        glb : Buffer.concat([ header, jsonHeader, jsonChunk, binHeader, binChunk ]),
        triangles : geo.indices.length / 3,
        size : [ geo.max[0] - geo.min[0], geo.max[1] - geo.min[1], geo.max[2] - geo.min[2] ],
    };
}

const out  = build();
const dest = path.join(__dirname, '..', 'http_resources', 'placeholder_avatar.glb');
fs.writeFileSync(dest, out.glb);
console.log('Wrote ' + dest + ' (' + out.glb.length + ' bytes, ' + out.triangles + ' triangles, ' +
            out.size.map(v => v.toFixed(2)).join(' x ') + ' m)');
