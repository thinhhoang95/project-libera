import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyReferenceInput, extractIdentifiers, isbn10To13, isValidIsbn10, isValidIsbn13, normalizeArxivId, normalizeDoi, normalizeIsbn,
  normalizeIssn, normalizePmcid, normalizePmid, splitBibliography,
} from "../../src/lib/references/identifiers";

test("normalizes DOIs: prefixes, URL encoding, case and trailing punctuation", () => {
  const cases: Array<[string, string | undefined]> = [
    ["10.1000/ABC", "10.1000/abc"], ["https://doi.org/10.1000/ABC", "10.1000/abc"], ["http://dx.doi.org/10.1000/abc", "10.1000/abc"],
    ["doi:10.1000/xyz.", "10.1000/xyz"], ["DOI: 10.1000/xyz,", "10.1000/xyz"], ["doi.org/10.1000/a;", "10.1000/a"],
    ["https://doi.org/10.1000%2Fabc%3A1", "10.1000/abc:1"], ["info:doi/10.1000/abc", "10.1000/abc"], ["<10.1000/abc>", "10.1000/abc"],
    ["10.1016/S0140-6736(20)30183-5", "10.1016/s0140-6736(20)30183-5"], ["10.1016/S0140-6736(20)30183-5)", "10.1016/s0140-6736(20)30183-5"],
    ["10.1016/S0140-6736(20)30183-5).", "10.1016/s0140-6736(20)30183-5"], ["10.1000/a[1]", "10.1000/a[1]"], ["10.1000/a[1]]", "10.1000/a[1]"],
    ["10.1002/(SICI)1097-4636(199706)35:4<419::AID-JBM2>3.0.CO;2-J", "10.1002/(sici)1097-4636(199706)35:4<419::aid-jbm2>3.0.co;2-j"],
    ["10.48550/arXiv.2101.00001", "10.48550/arxiv.2101.00001"], ["10.12/abc", undefined], ["not a doi", undefined], ["", undefined],
    ["10.1000/", undefined], ["https://example.org/10.1000/abc", undefined],
  ];
  for (const [input, expected] of cases) assert.equal(normalizeDoi(input), expected, input);
});

test("normalizes arXiv IDs in every form and rejects impossible ones", () => {
  const cases: Array<[string, string | undefined]> = [
    ["2101.00001", "2101.00001"], ["2101.00001v2", "2101.00001"], ["arXiv:2101.00001v2", "2101.00001"], ["arxiv: 1501.00001", "1501.00001"],
    ["https://arxiv.org/abs/2101.00001", "2101.00001"], ["https://arxiv.org/pdf/2101.00001v3.pdf", "2101.00001"], ["arxiv.org/abs/2101.00001.", "2101.00001"],
    ["0704.0001", "0704.0001"], ["hep-th/9901001", "hep-th/9901001"], ["arXiv:hep-th/9901001v1", "hep-th/9901001"],
    ["math.AG/0309136", "math.AG/0309136"], ["https://arxiv.org/abs/cond-mat/0102536v1", "cond-mat/0102536"],
    ["10.48550/arXiv.2101.00001", "2101.00001"], ["https://doi.org/10.48550/arXiv.2101.00001", "2101.00001"],
    ["1413.00001", undefined], ["1401.00001", undefined], ["1501.0001", undefined], ["foo/1234567", undefined], ["2101.001", undefined], ["", undefined],
  ];
  for (const [input, expected] of cases) assert.equal(normalizeArxivId(input), expected, input);
});

test("validates ISBN and ISSN checksums and converts ISBN-10 to ISBN-13", () => {
  assert.equal(isValidIsbn10("0262033844"), true);
  assert.equal(isValidIsbn10("080442957X"), true);
  assert.equal(isValidIsbn10("0262033845"), false);
  assert.equal(isValidIsbn13("9780262033848"), true);
  assert.equal(isValidIsbn13("9780262033849"), false);
  assert.equal(isValidIsbn13("1230262033848"), false, "ISBN-13 starts with 978 or 979");
  assert.equal(isbn10To13("0262033844"), "9780262033848");
  const isbns: Array<[string, string | undefined]> = [
    ["0262033844", "9780262033848"], ["0-262-03384-4", "9780262033848"], ["0 262 03384 4", "9780262033848"], ["ISBN 0-8044-2957-X", "9780804429573"],
    ["isbn-13: 978-3-16-148410-0", "9783161484100"], ["978 3 16 148410 0", "9783161484100"], ["9780262033849", undefined], ["0-262-03384-5", undefined],
    ["12345", undefined], ["", undefined],
  ];
  for (const [input, expected] of isbns) assert.equal(normalizeIsbn(input), expected, input);
  const issns: Array<[string, string | undefined]> = [
    ["0378-5955", "0378-5955"], ["03785955", "0378-5955"], ["ISSN 2049-3630", "2049-3630"], ["eISSN: 0317-8471", "0317-8471"],
    ["0378-5954", undefined], ["1234", undefined],
  ];
  for (const [input, expected] of issns) assert.equal(normalizeIssn(input), expected, input);
  assert.equal(normalizePmid("PMID: 00123"), "123");
  assert.equal(normalizePmid("https://pubmed.ncbi.nlm.nih.gov/31452104/"), "31452104");
  assert.equal(normalizePmid("abc"), undefined);
  assert.equal(normalizePmcid("PMCID: PMC1234567"), "PMC1234567");
  assert.equal(normalizePmcid("https://www.ncbi.nlm.nih.gov/pmc/articles/PMC1234567/"), "PMC1234567");
  assert.equal(normalizePmcid("1234567"), "PMC1234567");
  assert.equal(normalizePmcid("PMCX"), undefined);
});

test("extracts every identifier from free text", () => {
  const text = [
    "Smith J, et al. A study (doi:10.1000/ABC.123). Nature. 2020;1:2-3. PMID: 31452104; PMCID: PMC6712345.",
    "Preprint at arXiv:2101.00001v2 and https://arxiv.org/abs/hep-th/9901001v1, see also https://doi.org/10.1016/S0140-6736(20)30183-5).",
    "Book: ISBN 0-262-03384-4, and 978-3-16-148410-0; not an ISBN: 9780262033849 or 0262033845, phone 0262033844.",
    "Another DOI 10.1000/xyz, a page https://example.org/page?a=1. Also https://pubmed.ncbi.nlm.nih.gov/12345/ and 10.48550/arXiv.2201.00002.",
  ].join("\n");
  const found = extractIdentifiers(text);
  assert.equal(found.doi, "10.1000/abc.123");
  assert.deepEqual(found.all.doi, ["10.1000/abc.123", "10.1016/s0140-6736(20)30183-5", "10.1000/xyz", "10.48550/arxiv.2201.00002"]);
  assert.equal(found.arxiv, "hep-th/9901001");
  assert.deepEqual(found.all.arxiv.sort(), ["2101.00001", "2201.00002", "hep-th/9901001"]);
  assert.deepEqual(found.isbn, ["9780262033848", "9783161484100"]);
  assert.equal(found.pmid, "12345");
  assert.deepEqual(found.all.pmid.sort(), ["12345", "31452104"]);
  assert.equal(found.pmcid, "PMC6712345");
  assert.deepEqual(found.urls, [
    "https://arxiv.org/abs/hep-th/9901001v1", "https://doi.org/10.1016/S0140-6736(20)30183-5", "https://example.org/page?a=1",
    "https://pubmed.ncbi.nlm.nih.gov/12345/",
  ]);
  assert.deepEqual(extractIdentifiers("nothing here"), { urls: [], all: { doi: [], arxiv: [], pmid: [], pmcid: [] } });
});

test("classifies what the user pasted", () => {
  const cases: Array<[string, string, string?]> = [
    ["10.1000/ABC", "doi", "10.1000/abc"], ["doi: 10.1000/abc", "doi", "10.1000/abc"], ["https://doi.org/10.1000/abc", "doi", "10.1000/abc"],
    ["10.48550/arXiv.2101.00001", "doi", "10.48550/arxiv.2101.00001"], ["arXiv:2101.00001v1", "arxiv", "2101.00001"], ["2101.00001", "arxiv", "2101.00001"],
    ["https://arxiv.org/abs/hep-th/9901001", "arxiv", "hep-th/9901001"], ["ISBN 978-0-262-03384-8", "isbn", "9780262033848"],
    ["0-262-03384-4", "isbn", "9780262033848"], ["PMID: 31452104", "pmid", "31452104"], ["31452104", "pmid", "31452104"],
    ["https://pubmed.ncbi.nlm.nih.gov/31452104/", "pmid", "31452104"], ["PMC6712345", "pmcid", "PMC6712345"],
    ["https://www.ncbi.nlm.nih.gov/pmc/articles/PMC6712345/", "pmcid", "PMC6712345"], ["https://example.org/paper.", "url", "https://example.org/paper"],
    ["  @article{k, title = {T}}  ", "bibtex"], ["% comment\n@book{k,\n title={T}}", "bibtex"], ["TY  - JOUR\nTI  - T\nER  - ", "ris"],
    ['[{"type": "book", "title": "T"}]', "csl-json"], ['{"id": "x", "title": "T"}', "csl-json"], ["[1, 2]", "reference-text"],
    ["Smith J. A paper title. Nature. 2020;1:2-3.", "reference-text"], ["9780262033849", "reference-text"], ["", "reference-text"],
    ["[1] Smith J. First paper. Nature. 2020.\n[2] Doe A. Second paper. Science. 2019.", "bibliography"],
    ["Smith, J. (2020). First paper title here. Nature, 1, 2.\nDoe, A. (2019). Second paper title here. Science, 3, 4.", "bibliography"],
    ["A title that wraps\nonto a second line", "reference-text"],
  ];
  for (const [input, kind, value] of cases) assert.deepEqual(classifyReferenceInput(input), value === undefined ? { kind } : { kind, value }, input);
});

test("splits bibliographies by numbering, blank lines and hanging indents", () => {
  const cases: Array<[string, string[]]> = [
    ["[1] Smith J. First. Nature. 2020.\n[2] Doe A. Second\n    continued. Science. 2019.\n[10] Last. 2001.", ["Smith J. First. Nature. 2020.", "Doe A. Second continued. Science. 2019.", "Last. 2001."]],
    ["1. Smith J. First. 2020.\n2. Doe A. Second. 2019.", ["Smith J. First. 2020.", "Doe A. Second. 2019."]],
    ["(1) Smith J. First. 2020.\n(2) Doe A. Second. 2019.", ["Smith J. First. 2020.", "Doe A. Second. 2019."]],
    ["Smith, J. (2020). First paper\non two lines.\n\nDoe, A. (2019). Second.\n", ["Smith, J. (2020). First paper on two lines.", "Doe, A. (2019). Second."]],
    ["Smith, J. (2020). First paper\n   with a hanging indent.\nDoe, A. (2019). Second.\n   Continued.", ["Smith, J. (2020). First paper with a hanging indent.", "Doe, A. (2019). Second. Continued."]],
    ["Smith, J. (2020). First paper on\nmany lines, in Journal,\nVolume 3.\nDoe, A. (2019). Second.", ["Smith, J. (2020). First paper on many lines, in Journal, Volume 3.", "Doe, A. (2019). Second."]],
    ["Smith, J. (2020). A bio-\nlogical study.\r\nDoe, A. (2019). Second.", ["Smith, J. (2020). A biological study.", "Doe, A. (2019). Second."]],
    ["One reference only.", ["One reference only."]],
    ["", []],
  ];
  for (const [input, expected] of cases) assert.deepEqual(splitBibliography(input), expected, input);
});
