const path=require('node:path');

// Large integration fixtures belong to an external simulation project.
// The standalone extension does not need them for its default test suite.
function projectFile(...parts){
 const root=process.env.WAVE_TEST_PROJECT_ROOT;
 if(!root)throw Error('Set WAVE_TEST_PROJECT_ROOT to the simulation project for MAC/FPU integration tests');
 return path.resolve(root,...parts);
}
module.exports={projectFile};
