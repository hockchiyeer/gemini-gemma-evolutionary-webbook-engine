import assert from 'node:assert/strict';
import { isMeaningful } from '../../src/services/evolutionService.ts';
import { isMeaningfulText, looksLikeAssemblyCode } from '../../src/utils/webBookRender.ts';

// Ordinary definitions that the old /\b(call|add|pop|sub|int|push|ret|...)\b/ filter threw away.
const ordinaryDefinitions: Array<[string, string]> = [
  ['Function call', 'A function call transfers control to a subroutine and later returns to the point where it was made.'],
  ['Cache layer', 'Engineers add a cache layer to reduce repeated reads and cut latency for popular requests.'],
  ['Pop culture', 'Pop culture is the set of practices and beliefs that are dominant in a society at a given time.'],
  ['Sub-network', 'A sub network is a logical subdivision of an IP network that can be managed separately.'],
  ['Integer overflow', 'When a calculation would exceed the largest int the type can hold, the value wraps around.'],
  ['Push notification', 'A push notification is a message delivered to a device without the user requesting it.'],
];

for (const [term, description] of ordinaryDefinitions) {
  assert.equal(isMeaningfulText(term, description), true, `render-time filter wrongly rejected "${term}"`);
  assert.equal(isMeaningful(term, description), true, `generation-time filter wrongly rejected "${term}"`);
}

// Topical vocabulary is legitimate content, not scraper boilerplate (a book on security or law lives on these words).
const topical: Array<[string, string]> = [
  ['Cybersecurity', 'Cybersecurity is the practice of protecting systems, networks and data from digital attacks.'],
  ['Confidentiality', 'Confidentiality means that information is available only to those authorised to see it.'],
  ['Intellectual property', 'Intellectual property covers creations of the mind such as inventions, designs and artistic works.'],
  ['Copyright law', 'Copyright law gives authors exclusive rights over the reproduction of their original works.'],
];
for (const [term, description] of topical) {
  assert.equal(isMeaningfulText(term, description), true, `topical term "${term}" must not be treated as boilerplate`);
  assert.equal(isMeaningful(term, description), true, `topical term "${term}" must not be treated as boilerplate`);
}

// Real boilerplate and real machine code are still rejected.
assert.equal(isMeaningfulText('Footer', '© 2024 Example Corp. All rights reserved.'), false);
assert.equal(isMeaningfulText('Notice', 'Copyright 2024 Example Corp. Use of this site implies acceptance.'), false);
assert.equal(isMeaningfulText('Cookies', 'See our cookie policy and terms of use for details.'), false);
assert.equal(looksLikeAssemblyCode('mov eax, 1'), true);
assert.equal(looksLikeAssemblyCode('push ebp\nmov ebp, esp'), true);
assert.equal(looksLikeAssemblyCode('call 0x401000'), true);
assert.equal(looksLikeAssemblyCode('xor eax, eax'), true);
assert.equal(isMeaningfulText('Dump', 'mov eax, 1'), false);
assert.equal(isMeaningfulText('Listing', 'push ebp'), false);
assert.equal(looksLikeAssemblyCode('You can call this method, then add the result.'), false);

console.log('contentFilters tests passed');
