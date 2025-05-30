import { CompletionItem, CompletionItemKind } from "vscode-languageserver/node";
import { WorkspaceModel } from "../../models/workspace";
import { CompletionContext } from "./context-detector";
import { createSnippet } from "./snippets";

export class BlockCompletionProvider {
  private workspaceModel: WorkspaceModel;

  constructor(workspaceModel: WorkspaceModel) {
    this.workspaceModel = workspaceModel;
  }

  /**
   * Get completions for block declarations
   */
  public getCompletions(context: CompletionContext): CompletionItem[] {
    if (context.type === "empty") {
      return this.getBlockTypeCompletions();
    }

    if (context.type === "block") {
      return this.getBlockNameCompletions(context);
    }

    return [];
  }

  /**
   * Get completions for block types (view, dimension, etc.)
   */
  private getBlockTypeCompletions(): CompletionItem[] {
    return [
      "derived_table",
      "dimension_group",
      "dimension",
      "explore",
      "filter",
      "join",
      "measure",
      "model",
      "parameter",
      "relationship",
      "sql_on",
      "type",
      "view",
    ].map((keyword) => ({
      label: keyword,
      kind: CompletionItemKind.Class,
      insertText: `${keyword}`,
      data: { type: "keyword" },
    }));
  }

  /**
   * Get completions for block names based on the block type
   */
  private getBlockNameCompletions(
    context: CompletionContext
  ): CompletionItem[] {
    console.log("getBlockNameCompletions context", context);
    if (!context.blockType) return [];

    // For explore or join blocks, suggest view names
    if (["explore", "join"].includes(context.blockType)) {
      return this.getViewNameCompletions(true);
    }

    // For 'extends', 'from', or 'view_name', suggest view names
    if (["extends", "from", "view_name"].includes(context.blockType)) {
      return this.getViewNameCompletions();
    }

    // Create a snippet for the given block type
    if (this.hasSnippet(context.blockType)) {
      return [createSnippet(context.blockType)];
    }

    // Otherwise, suggest a generic name completion
    return [
      {
        label: `${context.blockType}_name`,
        kind: CompletionItemKind.Value,
        insertText: `${context.blockType}_name {`,
        data: { type: "block_name" },
      },
    ];
  }

  /**
   * Get completions for view names (used in extends, from, etc.)
   */
  private getViewNameCompletions(includeSpace?: boolean): CompletionItem[] {
    return Array.from(
      this.workspaceModel?.getViews()?.entries() as Iterable<[string, any]>
    ).map(([viewName]) => ({
      label: includeSpace ? ` ${viewName}` : viewName,
      kind: CompletionItemKind.Reference,
      data: { type: "view-ref" },
      detail: `View: ${viewName}`,
    }));
  }

  /**
   * Check if we have a snippet for the given block type
   */
  private hasSnippet(blockType: string): boolean {
    return [
      "view",
      "explore",
      "dimension",
      "dimension_group",
      "measure",
      "join",
      "filter",
    ].includes(blockType);
  }
}