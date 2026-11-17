// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

const path=require('node:path');

// Large integration fixtures belong to an external simulation project.
// The standalone extension does not need them for its default test suite.
function projectFile(...parts){
 const root=process.env.WAVE_TEST_PROJECT_ROOT;
 if(!root)throw Error('Set WAVE_TEST_PROJECT_ROOT to the simulation project for MAC/FPU integration tests');
 return path.resolve(root,...parts);
}
module.exports={projectFile};
