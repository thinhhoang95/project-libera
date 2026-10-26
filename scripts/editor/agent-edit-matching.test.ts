import assert from "node:assert/strict";
import test from "node:test";
import { canonicalForMatch, closestLines, findEditTarget } from "../../src/lib/agent/tools";

function apply(content: string, oldString: string, newString: string) {
  const target = findEditTarget(content, oldString, newString);
  assert.equal(target.matches.length, 1, `expected one match for ${JSON.stringify(oldString)}`);
  const [match] = target.matches;
  return { text: content.slice(0, match.index) + target.newString + content.slice(match.index + match.length), note: target.note };
}

test("exact matches need no normalization and carry no note", () => {
  const result = apply("The budget is 40k.\n", "40k", "50k");
  assert.equal(result.text, "The budget is 50k.\n");
  assert.equal(result.note, undefined);
});

test("typographic differences match: quotes, dashes, ellipses, special spaces, invisible characters", () => {
  const cases: Array<[string, string]> = [
    ["He said “hello” to ‘them’.", "He said \"hello\" to 'them'."],
    ["Results — as expected — held.", "Results -- as expected -- held."],
    ["Results – held.", "Results - held."],
    ["Wait… what?", "Wait... what?"],
    ["Mass is 10 kg here.", "Mass is 10 kg here."],
    ["Mass is 10 kg here.", "Mass is 10 kg here."],
    ["zero​width and soft­hyphen", "zerowidth and softhyphen"],
    ["Byte﻿order mark", "Byteorder mark"],
    ["Café au lait", "Café au lait"],
    ["two  spaces   inside", "two spaces inside"],
  ];
  for (const [content, oldString] of cases) {
    const target = findEditTarget(`${content}\n`, oldString, "X");
    assert.equal(target.matches.length, 1, `${JSON.stringify(oldString)} should match ${JSON.stringify(content)}`);
    assert.equal(target.matches[0].index, 0);
    assert.equal(target.matches[0].length, content.length, `the whole original span of ${JSON.stringify(content)}`);
    assert.match(target.note ?? "", /typographic differences/);
  }
});

test("trailing spaces and CRLF are forgiven together, and new_string takes the file's line endings", () => {
  const content = "first line  \r\nsecond line\r\nthird\r\n";
  const result = apply(content, "first line\nsecond line", "line one\nline two");
  assert.equal(result.text, "line one\r\nline two\r\nthird\r\n");
});

test("line-number prefixes combine with typographic normalization", () => {
  const result = apply("# Plan\n\nIt’s 40k.\n", "     3\tIt's 40k.", "     3\tIt's 50k.");
  assert.equal(result.text, "# Plan\n\nIt's 50k.\n");
  assert.match(result.note ?? "", /line-number prefixes[\s\S]*typographic/);
});

test("anything that changes meaning still fails: words, digits, negation, case, punctuation", () => {
  const content = "The effect was not significant at p < 0.05 in 2019.\n";
  for (const oldString of [
    "The effect was significant at p < 0.05",
    "The effect was not significant at p < 0.01",
    "significant at p < 0.05 in 2018",
    "the effect was not significant",
    "The effect was not significant, at p",
  ]) {
    assert.equal(findEditTarget(content, oldString, "X").matches.length, 0, JSON.stringify(oldString));
  }
});

test("indentation is not collapsed", () => {
  const content = "- item\n    - nested\n";
  assert.equal(findEditTarget(content, "- item\n  - nested", "X").matches.length, 0);
  assert.equal(findEditTarget(content, "- item\n\t- nested", "X").matches.length, 0);
  assert.equal(findEditTarget(content, "- item\n    - nested", "X").matches.length, 1);
});

test("normalized matches stay ambiguous when the passage occurs twice", () => {
  const content = "It’s here.\nIt's here.\n";
  assert.equal(findEditTarget(content, "It's here.", "X").matches.length, 1, "the exact occurrence wins first");
  assert.equal(findEditTarget("It’s here.\nIt‘s here.\n", "It's here.", "X").matches.length, 2);
});

test("a match never starts or ends inside an ellipsis", () => {
  assert.equal(findEditTarget("Wait… what\n", "Wait..", "X").matches.length, 0);
  assert.equal(findEditTarget("Wait… what\n", ". what", "X").matches.length, 0);
});

test("canonical offsets map back to the original text", () => {
  const canonical = canonicalForMatch("a  b — c…");
  assert.equal(canonical.text, "a b - c...");
  assert.deepEqual([canonical.starts[1], canonical.ends[1]], [1, 3]);
  assert.deepEqual([canonical.starts[4], canonical.ends[4]], [5, 6]);
});

test("the not-found hint shows the closest passage, not just similar first lines", () => {
  const content = [
    "# Methods",
    "",
    "We sampled 120 participants from three regional clinics over six months.",
    "Each participant completed the survey twice.",
    "",
    "# Results",
  ].join("\n");
  const hint = closestLines(content, "We sampled 112 participants from three regional clinic over six months.\nEach participant completed the survey twice.");
  assert.match(hint, /closest passage \(about 9\d% the same\) is at lines 3-4/);
  assert.match(hint, /3\tWe sampled 120 participants/);
  assert.match(hint, /4\tEach participant completed the survey twice\./);
});

test("the not-found hint falls back to line matching for short or unrelated text", () => {
  const content = "# Atlas\n\nProject Orion notes.\nBudget: see plan.\n";
  assert.match(closestLines(content, "Project Orion notez."), /closest lines[\s\S]*3\tProject Orion notes\./);
  assert.equal(closestLines(content, "Completely different words that appear nowhere at all."), "");
});
