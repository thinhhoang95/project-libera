import { compileFind, compileFindReplacement, replaceAllInText } from "./index";
import type { FindPreset, FindRecipeStep } from "./presets";
import type { FindError, FindFlavor } from "./types";

/* Recipes: an ordered list of find & replace steps, each run over the result of
 * the one before, applied by the editor as one edit (one undo step). */

export type RecipeStepResult = { replaced: number; skipped: number; incomplete: boolean; error?: FindError };

export type RecipeResult = { text: string; steps: RecipeStepResult[]; replaced: number; skipped: number };

export function recipeSteps(preset: FindPreset): FindRecipeStep[] {
  return preset.steps?.length ? preset.steps : [preset];
}

/** Runs every step over `text` in order. A step that does not compile is reported and skipped. */
export function runRecipe(text: string, steps: readonly FindRecipeStep[], flavor: FindFlavor): RecipeResult {
  let current = text;
  const results: RecipeStepResult[] = [];
  for (const step of steps) {
    const compiled = compileFind(step.query, {
      mode: step.mode,
      matchCase: step.matchCase ?? false,
      wholeWord: step.wholeWord ?? false,
      flexibleSpacing: step.flexibleSpacing ?? false,
      scope: step.scope ?? "anywhere",
      flavor,
    });
    if (!compiled.ok) { results.push({ replaced: 0, skipped: 0, incomplete: false, error: compiled.error }); continue; }
    const replacement = compileFindReplacement(compiled.finder, step.replacement, step.preserveCase ?? false);
    if (!replacement.ok) { results.push({ replaced: 0, skipped: 0, incomplete: false, error: replacement.error }); continue; }
    const found = compiled.finder.find(current);
    const applied = replaceAllInText(current, found.matches, replacement.replacer);
    current = applied.text;
    results.push({ replaced: applied.replaced, skipped: applied.skipped, incomplete: found.incomplete });
  }
  return {
    text: current,
    steps: results,
    replaced: results.reduce((sum, step) => sum + step.replaced, 0),
    skipped: results.reduce((sum, step) => sum + step.skipped, 0),
  };
}
