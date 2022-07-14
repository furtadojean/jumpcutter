/**
 * @license
 * Copyright (C) 2021, 2022  WofWca <wofwca@protonmail.com>
 *
 * This file is part of Jump Cutter Browser Extension.
 *
 * Jump Cutter Browser Extension is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Jump Cutter Browser Extension is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with Jump Cutter Browser Extension.  If not, see <https://www.gnu.org/licenses/>.
 */

export const enum SpeedName {
  SOUNDED,
  SILENCE,
}
// A workaround for Svele not being able to import const enums.
// It appears to be related to the fact that we don't use Svelte's typescript base config
// https://svelte.dev/blog/svelte-and-typescript
// https://github.com/tsconfig/bases/blob/main/bases/svelte.json
// TODO raise an issue?
export const SpeedName_SOUNDED = SpeedName.SOUNDED;
export const SpeedName_SILENCE = SpeedName.SILENCE;
