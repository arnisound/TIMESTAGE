import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  createRoomState,
  applyCommand,
  addVote,
  publicState,
  viewerState,
  RoomStore,
} from '../server/rooms.js';
import { pollTally, pollLetter, pollVoteLabel, POLL_LIMITS } from '../shared/poll.js';

/** Salle avec un sondage pret a recevoir des votes. */
function roomWithPoll(options = ['Le son', 'La lumiere', 'La video']) {
  const room = createRoomState('POLLS');
  const result = applyCommand(room, 'poll.set', { question: 'Quel sujet approfondir ?', options });
  assert.equal(result.ok, true);
  return room;
}

test('un sondage se cree avec ses reponses numerotees', () => {
  const room = roomWithPoll();
  assert.equal(room.poll.question, 'Quel sujet approfondir ?');
  assert.equal(room.poll.options.length, 3);
  assert.deepEqual(room.poll.options.map((o) => o.label), ['Le son', 'La lumiere', 'La video']);
  assert.ok(room.poll.options.every((o) => o.votes === 0));
  assert.equal(room.poll.open, true, 'le vote est ouvert des le lancement');
  assert.equal(room.poll.reveal, false, "les resultats n'apparaissent pas tout seuls");
  assert.equal(room.poll.onStage, false);
});

test('un sondage refuse une question vide ou une seule reponse', () => {
  const room = createRoomState('POLLS');
  assert.equal(applyCommand(room, 'poll.set', { question: '   ', options: ['A', 'B'] }).ok, false);
  assert.equal(applyCommand(room, 'poll.set', { question: 'Et alors ?', options: ['Seule'] }).ok, false);
  assert.equal(room.poll, null);
});

test('les reponses sont bornees et nettoyees', () => {
  const room = createRoomState('POLLS');
  applyCommand(room, 'poll.set', {
    question: 'x'.repeat(400),
    options: ['  Premiere  ', '', 'y'.repeat(200), 'C', 'D', 'E', 'F', 'G', 'H'],
  });
  assert.equal(room.poll.question.length, POLL_LIMITS.question);
  assert.equal(room.poll.options.length, POLL_LIMITS.maxOptions, 'pas plus de reponses que la limite');
  assert.equal(room.poll.options[0].label, 'Premiere', 'les espaces sont retires');
  assert.equal(room.poll.options[1].label.length, POLL_LIMITS.option);
});

test('un votant ne compte qu une voix et peut changer d avis', () => {
  const room = roomWithPoll();
  const [a, b] = room.poll.options;

  assert.equal(addVote(room, { optionId: a.id, voterId: 'v1' }).ok, true);
  assert.equal(addVote(room, { optionId: a.id, voterId: 'v1' }).changed, false, 'revoter pareil ne compte pas deux fois');
  assert.equal(a.votes, 1);

  addVote(room, { optionId: b.id, voterId: 'v1' });
  assert.equal(a.votes, 0, 'la voix quitte la premiere reponse');
  assert.equal(b.votes, 1);

  addVote(room, { optionId: b.id, voterId: 'v2' });
  assert.equal(b.votes, 2);
});

test('le vote refuse ce qui n a pas lieu d etre', () => {
  const room = roomWithPoll();
  const option = room.poll.options[0];
  assert.equal(addVote(room, { optionId: 'inconnu', voterId: 'v1' }).ok, false);
  assert.equal(addVote(room, { optionId: option.id, voterId: '  ' }).ok, false);
  assert.equal(addVote(room, { optionId: option.id, voterId: 'v1', pollId: 'autre' }).ok, false, 'sondage deja remplace');

  applyCommand(room, 'poll.open', { open: false });
  assert.equal(addVote(room, { optionId: option.id, voterId: 'v9' }).ok, false, 'vote clos');
  assert.equal(room.poll.closedAt > 0, true);

  const vide = createRoomState('VIDES');
  assert.equal(addVote(vide, { optionId: 'x', voterId: 'v1' }).ok, false);
});

test('le public ne voit les chiffres que si la regie les ouvre', () => {
  const room = roomWithPoll();
  const [a, b] = room.poll.options;
  addVote(room, { optionId: a.id, voterId: 'v1' });
  addVote(room, { optionId: a.id, voterId: 'v2' });
  addVote(room, { optionId: b.id, voterId: 'v3' });

  const masque = viewerState(room).poll;
  assert.equal(masque.resultsVisible, false);
  assert.deepEqual(masque.options.map((o) => o.votes), [0, 0, 0], 'aucun compteur ne fuit');
  assert.equal(masque.voterCount, 3, 'la participation, elle, reste affichable');

  const regie = publicState(room).poll;
  assert.equal(regie.resultsVisible, true, 'la regie depouille en direct');
  assert.deepEqual(regie.options.map((o) => o.votes), [2, 1, 0]);

  applyCommand(room, 'poll.reveal', { reveal: true });
  assert.deepEqual(viewerState(room).poll.options.map((o) => o.votes), [2, 1, 0]);
});

test('la liste des votants ne sort jamais du serveur', () => {
  const room = roomWithPoll();
  addVote(room, { optionId: room.poll.options[0].id, voterId: 'telephone-de-sam' });
  for (const state of [publicState(room), viewerState(room)]) {
    assert.equal(state.poll.voters, undefined);
    assert.ok(!JSON.stringify(state).includes('telephone-de-sam'));
  }
});

test('remise a zero, ecran et suppression', () => {
  const room = roomWithPoll();
  addVote(room, { optionId: room.poll.options[0].id, voterId: 'v1' });

  applyCommand(room, 'poll.stage', { onStage: true });
  assert.equal(room.poll.onStage, true);

  applyCommand(room, 'poll.reset', {});
  assert.deepEqual(room.poll.options.map((o) => o.votes), [0, 0, 0]);
  assert.deepEqual(room.poll.voters, {}, 'chacun peut revoter apres une remise a zero');
  assert.equal(room.poll.onStage, true, 'le sondage reste a l ecran');

  // Un nouveau sondage prend la place du precedent, ecran compris.
  applyCommand(room, 'poll.set', { question: 'Autre question ?', options: ['Oui', 'Non'] });
  assert.equal(room.poll.onStage, true);
  assert.equal(room.poll.options.length, 2);

  applyCommand(room, 'room.reset', {});
  assert.equal(room.poll.onStage, false, 'la remise a zero de la salle libere l ecran');

  applyCommand(room, 'poll.clear', {});
  assert.equal(room.poll, null);
  assert.equal(applyCommand(room, 'poll.reveal', { reveal: true }).ok, false);
});

test('un sondage survit a un redemarrage du serveur', (t) => {
  const file = new URL('../data/test-poll.json', import.meta.url).pathname;
  const store = new RoomStore({ file });
  t.after(() => {
    try { fs.unlinkSync(file); } catch { /* deja parti */ }
  });
  const { room } = store.create('Avec sondage');
  applyCommand(room, 'poll.set', { question: 'On continue ?', options: ['Oui', 'Non'] });
  addVote(room, { optionId: room.poll.options[0].id, voterId: 'v1' });
  store.save();

  const restored = new RoomStore({ file });
  const back = restored.get(room.code);
  assert.equal(back.poll.question, 'On continue ?');
  assert.equal(back.poll.options[0].votes, 1);
  assert.equal(back.poll.voters.v1, back.poll.options[0].id, 'un votant ne revote pas apres un redemarrage');
});

test('le depouillement calcule parts et tete de course', () => {
  const tally = pollTally({ options: [{ id: 'a', label: 'A', votes: 3 }, { id: 'b', label: 'B', votes: 1 }] });
  assert.equal(tally.total, 4);
  assert.equal(tally.options[0].share, 0.75);
  assert.equal(tally.options[0].leading, true);
  assert.equal(tally.options[1].leading, false);

  const vide = pollTally({ options: [{ id: 'a', label: 'A', votes: 0 }, { id: 'b', label: 'B', votes: 0 }] });
  assert.equal(vide.total, 0);
  assert.ok(vide.options.every((o) => !o.leading), 'sans voix, rien ne domine');
  assert.equal(vide.options[0].share, 0, 'pas de division par zero');

  assert.deepEqual(pollTally(null).options, []);
  assert.equal(pollLetter(0) + pollLetter(2), 'AC');
  assert.equal(pollVoteLabel(1), '1 vote');
  assert.equal(pollVoteLabel(12), '12 votes');
});
