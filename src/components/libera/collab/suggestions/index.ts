// Suggestions on shared documents (plan M3.1–M3.3):
//
//   <CommentsWithSuggestions tabId comments={<ReviewComments />} />   the Comments rail with Suggestions and Reviews tabs on shared files
//   <SuggestionsPanel session />                                     the list, filters and decisions
//   useSuggestions(session)                                          the document's controller and snapshot

export { CommentsWithSuggestions } from "./comments-with-suggestions";
export { SuggestionsPanel, filterSuggestionGroups, type SuggestionAuthorFilter, type SuggestionsPanelProps } from "./suggestions-panel";
export { useSuggestions } from "./use-suggestions";
