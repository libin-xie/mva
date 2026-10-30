// Minimal declarations for the parts of the VS Code API this extension uses.
// (Stand-in for @types/vscode; signatures match the real API.)
declare module 'vscode' {
  export class Uri {
    static file(path: string): Uri;
    static parse(value: string): Uri;
    static joinPath(base: Uri, ...pathSegments: string[]): Uri;
    readonly scheme: string;
    readonly fsPath: string;
    readonly path: string;
    toString(): string;
  }
  export interface Disposable { dispose(): any; }
  export interface Memento {
    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue: T): T;
    update(key: string, value: any): PromiseLike<void>;
  }
  export interface ExtensionContext {
    readonly subscriptions: { dispose(): any }[];
    readonly globalState: Memento;
    readonly extensionUri: Uri;
  }
  export interface TextDocument {
    readonly uri: Uri;
    readonly fileName: string;
    readonly isUntitled: boolean;
    readonly languageId: string;
    getText(): string;
  }
  export interface TextEditor { readonly document: TextDocument; }
  export interface WorkspaceFolder { readonly uri: Uri; readonly name: string; readonly index: number; }
  export enum ConfigurationTarget { Global = 1, Workspace = 2, WorkspaceFolder = 3 }
  export interface WorkspaceConfiguration {
    get<T>(section: string): T | undefined;
    get<T>(section: string, defaultValue: T): T;
    update(section: string, value: any, configurationTarget?: ConfigurationTarget | boolean): PromiseLike<void>;
  }
  export namespace workspace {
    const workspaceFolders: readonly WorkspaceFolder[] | undefined;
    function getWorkspaceFolder(uri: Uri): WorkspaceFolder | undefined;
    function getConfiguration(section?: string, scope?: Uri | null): WorkspaceConfiguration;
    function openTextDocument(uri: Uri): PromiseLike<TextDocument>;
  }
  export namespace window {
    const activeTextEditor: TextEditor | undefined;
    function showInformationMessage<T extends string>(message: string, ...items: T[]): PromiseLike<T | undefined>;
    function showWarningMessage<T extends string>(message: string, ...items: T[]): PromiseLike<T | undefined>;
    function showErrorMessage<T extends string>(message: string, ...items: T[]): PromiseLike<T | undefined>;
    function setStatusBarMessage(text: string, hideAfterTimeout: number): Disposable;
  }
  export namespace commands {
    function registerCommand(command: string, callback: (...args: any[]) => any, thisArg?: any): Disposable;
    function executeCommand<T = unknown>(command: string, ...rest: any[]): PromiseLike<T>;
  }
  export namespace env {
    function openExternal(target: Uri): PromiseLike<boolean>;
  }
}
