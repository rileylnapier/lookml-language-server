import { Location, Position, Range } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import * as path from "path";
import { URI } from "vscode-uri";
import { parseFiles, Project } from "lookml-parser";
import * as fs from "fs/promises";
import * as os from "os";

// Define interfaces for LookML elements
export interface ViewInfo {
  name: string;
  location: Location;
  fields: Map<string, FieldInfo>;
  extends?: string; // Name of the view this extends
  properties: Map<string, PropertyInfo>;
}

export interface FieldInfo {
  name: string;
  type: "dimension" | "measure" | "parameter" | "filter";
  location: Location;
  properties: Map<string, PropertyInfo>;
}

export interface PropertyInfo {
  name: string;
  value: string;
  location: Location;
}

export interface ExploreInfo {
  name: string;
  location: Location;
  viewName?: string;
  joins: Map<string, JoinInfo>;
  properties: Map<string, PropertyInfo>;
}

export interface JoinInfo {
  name: string;
  location: Location;
  viewName?: string;
  sqlOn?: string;
  relationship?: string;
  properties: Map<string, PropertyInfo>;
}

export interface ModelInfo {
  name: string;
  location: Location;
  connection?: string;
  includes: string[];
  explores: string[];
  properties: Map<string, PropertyInfo>;
}

export interface ParseResult {
  views: Map<string, ViewInfo>;
  explores: Map<string, ExploreInfo>;
  models: Map<string, ModelInfo>;
  viewNames: string[];
  exploreNames: string[];
  modelNames: string[];
  isModelFile: boolean;
  modelName?: string;
}

export class LookMLParser {
  private lookmlProject: Project | null = null;
  private tempFilesDir: string | null = null;

  constructor() {
    this.initTempDir();
  }

  /**
   * Initialize temp directory for lookml-parser file operations
   */
  private async initTempDir(): Promise<void> {
    try {
      this.tempFilesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lookml-lsp-'));
      console.log(`Created temp directory: ${this.tempFilesDir}`);
    } catch (error) {
      console.error('Failed to create temp directory:', error);
    }
  }

  /**
   * Get the lookml-parser Project object
   */
  public getLookMLProject(): Project | null {
    return this.lookmlProject;
  }

  /**
   * Parse a document using both custom parsing and lookml-parser
   */
  public async parseDocument(document: TextDocument): Promise<ParseResult> {
    const uri = document.uri;
    const text = document.getText();
    
    // Initialize result with empty collections
    const result: ParseResult = {
      views: new Map<string, ViewInfo>(),
      explores: new Map<string, ExploreInfo>(),
      models: new Map<string, ModelInfo>(),
      viewNames: [],
      exploreNames: [],
      modelNames: [],
      isModelFile: false
    };

    // First do our custom parsing for location information
    this.customParseDocument(document, result);
    
    // Then enhance with lookml-parser if possible
    await this.enhanceWithLookMLParser(document, result);
    
    return result;
  }

  /**
   * Perform custom parsing to extract locations and basic structure
   */
  private customParseDocument(document: TextDocument, result: ParseResult): void {
    const text = document.getText();
    const lines = text.split("\n");
    const uri = document.uri;

    // Determine if this is a model file by checking extension or content
    result.isModelFile = 
      uri.endsWith(".model.lkml") ||
      text.includes("connection:") ||
      text.includes("include:");

    // Extract model name from filename if this is a model file
    if (result.isModelFile) {
      const fileNameMatch = uri.match(/([^\/]+)\.model\.lkml$/);
      if (fileNameMatch) {
        result.modelName = fileNameMatch[1];
      } else {
        // If no match from filename, use a fallback name
        result.modelName = `model_${Math.random().toString(36).substring(2, 9)}`;
      }
    }

    // Create a model entry if this is a model file
    if (result.isModelFile && result.modelName) {
      const modelInfo: ModelInfo = {
        name: result.modelName,
        location: Location.create(
          uri,
          Range.create(Position.create(0, 0), Position.create(0, 0))
        ),
        includes: [],
        explores: [],
        properties: new Map(),
      };
      result.models.set(result.modelName, modelInfo);
      result.modelNames.push(result.modelName);
    }

    // Set up tracking for the current parsing state
    const blockStack: {
      type: string;
      name: string;
      level: number;
      startLine: number;
    }[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Skip empty lines and comments
      if (line === "" || line.startsWith("#")) {
        continue;
      }

      // Track top-level property assignments (for model files)
      const topLevelPropertyMatch = line.match(
        /^\s*([a-zA-Z0-9_]+):\s+(.+?)\s*(?:;;|$)/
      );
      if (result.isModelFile && topLevelPropertyMatch && blockStack.length === 0) {
        const propertyName = topLevelPropertyMatch[1];
        const propertyValue = topLevelPropertyMatch[2]
          .replace(/;;$/, "")
          .trim()
          .replace(/^["']|["']$/g, "");

        // Create property location
        const location = Location.create(
          uri,
          Range.create(
            Position.create(i, 0),
            Position.create(i, lines[i].length)
          )
        );

        const propertyInfo: PropertyInfo = {
          name: propertyName,
          value: propertyValue,
          location: location,
        };

        // Add to the model
        const modelInfo = result.modelName ? result.models.get(result.modelName) : undefined;
        if (modelInfo) {
          modelInfo.properties.set(propertyName, propertyInfo);

          // Handle special properties
          if (propertyName === "connection") {
            modelInfo.connection = propertyValue;
          } else if (propertyName === "include") {
            modelInfo.includes.push(propertyValue);
          } else if (propertyName === "explore") {
            // Handle top-level explore declarations
            modelInfo.explores.push(propertyValue);

            // Create a basic explore entry
            const exploreInfo: ExploreInfo = {
              name: propertyValue,
              location: location,
              joins: new Map(),
              properties: new Map(),
            };
            result.explores.set(propertyValue, exploreInfo);
            result.exploreNames.push(propertyValue);
          }
        }

        // Continue to next line since we've handled this property
        continue;
      }

      // Track block openings
      const blockMatch = line.match(
        /^\s*([a-zA-Z0-9_]+):\s+([a-zA-Z0-9_]+)\s*\{/
      );
      if (blockMatch) {
        const blockType = blockMatch[1];
        const blockName = blockMatch[2];
        const indentLevel = lines[i].length - lines[i].trimLeft().length;

        blockStack.push({
          type: blockType,
          name: blockName,
          level: indentLevel,
          startLine: i,
        });

        // Create location info
        const location = Location.create(
          uri,
          Range.create(
            Position.create(i, 0),
            Position.create(i, lines[i].length)
          )
        );

        // Register different block types
        if (blockType === "view") {
          const viewInfo: ViewInfo = {
            name: blockName,
            location: location,
            fields: new Map(),
            properties: new Map(),
          };
          result.views.set(blockName, viewInfo);
          result.viewNames.push(blockName);
        } else if (blockType === "explore") {
          const exploreInfo: ExploreInfo = {
            name: blockName,
            location: location,
            joins: new Map(),
            properties: new Map(),
          };
          result.explores.set(blockName, exploreInfo);
          result.exploreNames.push(blockName);
        } else if (blockType === "model") {
          const modelInfo: ModelInfo = {
            name: blockName,
            location: location,
            includes: [],
            explores: [],
            properties: new Map(),
          };
          result.models.set(blockName, modelInfo);
          result.modelNames.push(blockName);
        } else if (
          ["dimension", "measure", "parameter", "filter"].includes(blockType)
        ) {
          // We're inside a view, add this field to the current view
          if (blockStack.length >= 2) {
            const parentBlock = blockStack[blockStack.length - 2];
            if (parentBlock.type === "view") {
              const viewInfo = result.views.get(parentBlock.name);
              if (viewInfo) {
                const fieldInfo: FieldInfo = {
                  name: blockName,
                  type: blockType as
                    | "dimension"
                    | "measure"
                    | "parameter"
                    | "filter",
                  location: location,
                  properties: new Map(),
                };
                viewInfo.fields.set(blockName, fieldInfo);
              }
            }
          }
        } else if (blockType === "join") {
          // Add join to an explore
          if (blockStack.length >= 2) {
            const parentBlock = blockStack[blockStack.length - 2];
            if (parentBlock.type === "explore") {
              const exploreInfo = result.explores.get(parentBlock.name);
              if (exploreInfo) {
                const joinInfo: JoinInfo = {
                  name: blockName,
                  location: location,
                  properties: new Map(),
                };
                exploreInfo.joins.set(blockName, joinInfo);
              }
            }
          }
        }
      }

      // Track property assignments inside blocks
      const propertyMatch = line.match(
        /^\s*([a-zA-Z0-9_]+):\s+(.+?)\s*(?:;;|$)/
      );
      if (propertyMatch && blockStack.length > 0) {
        const propertyName = propertyMatch[1];
        const propertyValue = propertyMatch[2].replace(/;;$/, "").trim();
        const location = Location.create(
          uri,
          Range.create(
            Position.create(i, 0),
            Position.create(i, lines[i].length)
          )
        );

        const propertyInfo: PropertyInfo = {
          name: propertyName,
          value: propertyValue,
          location: location,
        };

        // Add to the appropriate parent
        const currentBlock = blockStack[blockStack.length - 1];

        if (currentBlock.type === "view") {
          const viewInfo = result.views.get(currentBlock.name);
          if (viewInfo) {
            viewInfo.properties.set(propertyName, propertyInfo);

            // Handle special properties
            if (propertyName === "extends") {
              viewInfo.extends = propertyValue;
            }
          }
        } else if (currentBlock.type === "explore") {
          const exploreInfo = result.explores.get(currentBlock.name);
          if (exploreInfo) {
            exploreInfo.properties.set(propertyName, propertyInfo);

            // Handle special properties
            if (propertyName === "view_name" || propertyName === "from") {
              exploreInfo.viewName = propertyValue;
            }
          }
        } else if (currentBlock.type === "model") {
          const modelInfo = result.models.get(currentBlock.name);
          if (modelInfo) {
            modelInfo.properties.set(propertyName, propertyInfo);

            // Handle special properties
            if (propertyName === "connection") {
              modelInfo.connection = propertyValue;
            } else if (propertyName === "include") {
              modelInfo.includes.push(propertyValue);
            }
          }
        } else if (
          ["dimension", "measure", "parameter", "filter"].includes(
            currentBlock.type
          )
        ) {
          // Find parent view
          for (let j = blockStack.length - 2; j >= 0; j--) {
            if (blockStack[j].type === "view") {
              const viewInfo = result.views.get(blockStack[j].name);
              if (viewInfo) {
                const fieldInfo = viewInfo.fields.get(currentBlock.name);
                if (fieldInfo) {
                  fieldInfo.properties.set(propertyName, propertyInfo);
                }
              }
              break;
            }
          }
        } else if (currentBlock.type === "join") {
          // Find parent explore
          for (let j = blockStack.length - 2; j >= 0; j--) {
            if (blockStack[j].type === "explore") {
              const exploreInfo = result.explores.get(blockStack[j].name);
              if (exploreInfo) {
                const joinInfo = exploreInfo.joins.get(currentBlock.name);
                if (joinInfo) {
                  joinInfo.properties.set(propertyName, propertyInfo);

                  // Handle special properties
                  if (propertyName === "view_name" || propertyName === "from") {
                    joinInfo.viewName = propertyValue;
                  } else if (propertyName === "sql_on") {
                    joinInfo.sqlOn = propertyValue;
                  } else if (propertyName === "relationship") {
                    joinInfo.relationship = propertyValue;
                  }
                }
              }
              break;
            }
          }
        }
      }

      // Track block closings
      if (line.match(/^\s*\}/)) {
        // Remove blocks that have ended
        const indentLevel = lines[i].length - lines[i].trimLeft().length;
        while (
          blockStack.length > 0 &&
          blockStack[blockStack.length - 1].level >= indentLevel
        ) {
          blockStack.pop();
        }
      }
    }
  }

  /**
   * Enhance the parse result with lookml-parser information
   */
  private async enhanceWithLookMLParser(document: TextDocument, result: ParseResult): Promise<void> {
    if (!this.tempFilesDir) {
      console.error('Temp directory not initialized');
      return;
    }

    try {
      const uri = document.uri;
      const content = document.getText();
      const fileUri = URI.parse(uri);
      const fileName = path.basename(fileUri.fsPath);
      
      // Write document content to temp file for lookml-parser to read
      const tempFilePath = path.join(this.tempFilesDir, fileName);
      await fs.writeFile(tempFilePath, content);

      // Parse the file using lookml-parser
      const parsedProject = await parseFiles([tempFilePath], {
        // Optional config
      });

      // Save the parsed project for reference
      this.lookmlProject = parsedProject;

      // Enhance our model with lookml-parser data
      if (parsedProject) {
        this.enhanceParsedResult(result, parsedProject);
      }
    } catch (error) {
      console.error(`Error using lookml-parser for ${document.uri}:`, error);
      // Continue with existing parser results if lookml-parser fails
    }
  }

  /**
   * Enhance our parse result with data from lookml-parser
   */
  private enhanceParsedResult(result: ParseResult, parsedProject: Project): void {
    // Process views from lookml-parser and enhance our existing views
    if (parsedProject.views) {
      Object.entries(parsedProject.views).forEach(([viewName, parsedView]) => {
        // Only process if this view is in our result
        const existingView = result.views.get(viewName);
        if (existingView) {
          // Enhance with lookml-parser data
          if (parsedView.extends) {
            existingView.extends = parsedView.extends;
          }

          // For each field in the parsed view, enhance our field data
          if (parsedView.dimensions) {
            Object.entries(parsedView.dimensions).forEach(([dimName, dimension]) => {
              const existingField = existingView.fields.get(dimName);
              if (existingField) {
                // Enhance with data from lookml-parser
                this.enhanceFieldWithParsedData(existingField, dimension);
              }
            });
          }

          if (parsedView.measures) {
            Object.entries(parsedView.measures).forEach(([measureName, measure]) => {
              const existingField = existingView.fields.get(measureName);
              if (existingField) {
                // Enhance with data from lookml-parser
                this.enhanceFieldWithParsedData(existingField, measure);
              }
            });
          }

          if (parsedView.filters) {
            Object.entries(parsedView.filters).forEach(([filterName, filter]) => {
              const existingField = existingView.fields.get(filterName);
              if (existingField) {
                // Enhance with data from lookml-parser
                this.enhanceFieldWithParsedData(existingField, filter);
              }
            });
          }

          if (parsedView.parameters) {
            Object.entries(parsedView.parameters).forEach(([paramName, param]) => {
              const existingField = existingView.fields.get(paramName);
              if (existingField) {
                // Enhance with data from lookml-parser
                this.enhanceFieldWithParsedData(existingField, param);
              }
            });
          }
        }
      });
    }

    // Process models and explores
    if (parsedProject.models) {
      Object.entries(parsedProject.models).forEach(([modelName, parsedModel]) => {
        const existingModel = result.models.get(modelName);
        if (existingModel) {
          // Enhance with lookml-parser data
          if (parsedModel.connection) {
            existingModel.connection = parsedModel.connection;
          }

          // Process explores
          if (parsedModel.explores) {
            Object.entries(parsedModel.explores).forEach(([exploreName, explore]) => {
              const existingExplore = result.explores.get(exploreName);
              if (existingExplore) {
                // Enhance with data from lookml-parser
                if (explore.from) {
                  existingExplore.viewName = explore.from;
                }

                // Process joins
                if (explore.joins) {
                  Object.entries(explore.joins).forEach(([joinName, join]) => {
                    const existingJoin = existingExplore.joins.get(joinName);
                    if (existingJoin) {
                      if (join.from) {
                        existingJoin.viewName = join.from;
                      }
                      if (join.sql_on) {
                        existingJoin.sqlOn = join.sql_on;
                      }
                      if (join.relationship) {
                        existingJoin.relationship = join.relationship;
                      }
                    }
                  });
                }
              }
            });
          }
        }
      });
    }
  }

  /**
   * Enhance a field with data from lookml-parser
   */
  private enhanceFieldWithParsedData(existingField: FieldInfo, parsedField: any): void {
    // Add any additional properties from lookml-parser
    Object.entries(parsedField).forEach(([propName, propValue]) => {
      if (propName !== 'name' && typeof propValue === 'string') {
        if (!existingField.properties.has(propName)) {
          // Add property if it doesn't exist in our model
          existingField.properties.set(propName, {
            name: propName,
            value: propValue,
            location: existingField.location // Use field location as fallback
          });
        }
      }
    });
  }

  /**
   * Generate diagnostics for a document using lookml-parser
   */
  public getDiagnostics(document: TextDocument): any[] {
    // This would use lookml-parser's validation capabilities
    // The actual implementation will depend on what lookml-parser provides
    const diagnostics: any[] = [];
    
    // Example implementation - actual code would use lookml-parser's validation
    if (this.lookmlProject && this.lookmlProject.errors) {
      // Convert lookml-parser errors to LSP diagnostics
      // (Implementation depends on the error format from lookml-parser)
    }
    
    return diagnostics;
  }

  /**
   * Get completions for a position using lookml-parser knowledge
   */
  public getCompletions(document: TextDocument, position: Position): any[] {
    // Implementation would use lookml-parser knowledge to provide smart completions
    const completions: any[] = [];
    
    // Example implementation - would be enhanced with lookml-parser knowledge
    return completions;
  }

  /**
   * Get hover info for a position using lookml-parser knowledge
   */
  public getHoverInfo(document: TextDocument, position: Position): any | null {
    // Implementation would use lookml-parser knowledge to provide rich hover info
    
    // Example implementation - would be enhanced with lookml-parser knowledge
    return null;
  }

  /**
   * Clean up temporary files
   */
  public async cleanup(): Promise<void> {
    if (this.tempFilesDir) {
      try {
        await fs.rm(this.tempFilesDir, { recursive: true, force: true });
        console.log(`Cleaned up temp directory: ${this.tempFilesDir}`);
      } catch (error) {
        console.error('Failed to clean up temp directory:', error);
      }
    }
  }
}