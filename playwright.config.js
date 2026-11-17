// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

module.exports={testDir:'./test',testMatch:'*.spec.js',timeout:30000,use:{headless:true,launchOptions:{executablePath:process.env.WAVE_CHROMIUM || undefined},viewport:{width:1440,height:850}},workers:1};
