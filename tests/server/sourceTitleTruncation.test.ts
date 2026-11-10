import assert from 'node:assert/strict';
import { cleanSourceTitle } from '../../src/services/evolutionService.ts';

// Search-clipped titles must not become chapter headings.
assert.equal(cleanSourceTitle('Singapore Chinese Cultural Cen...', 'https://singaporeccc.org.sg'), '');
assert.equal(cleanSourceTitle('新谣起源的历史研究 = The emergence of Xinyao (S...', 'https://dr.ntu.edu.sg/x'), '新谣起源的历史研究');
assert.equal(cleanSourceTitle('新谣的传播与新加坡文化记忆 - Singapore Federation o...', 'https://sfcca.sg/x'), '新谣的传播与新加坡文化记忆');
assert.equal(cleanSourceTitle('wikipedia', 'https://zh.wikipedia.org/wiki/x'), '');
console.log('sourceTitleTruncation tests passed');
