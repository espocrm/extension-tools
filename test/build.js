import {buildGeneral} from '../build.js';

buildGeneral({
    extensionHook: () => {
        console.log('  Extension install hook.');
    },
});
