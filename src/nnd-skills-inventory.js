// SPDX-License-Identifier: Apache-2.0
/** Metadata only; skill bodies and source paths remain engine-private. */
export function nndSkillsInventory(catalog) {
  return Object.freeze({
    version: 1,
    state: 'discovered',
    skills: Object.freeze(catalog.map((skill) => Object.freeze({
      id: skill.id, version: skill.version, description: skill.description,
      invocation: skill.invocation,
    }))),
  });
}
