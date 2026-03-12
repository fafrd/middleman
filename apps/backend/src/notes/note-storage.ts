import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { basename, resolve } from "node:path";

const NOTES_DIRECTORY_NAME = "notes";
const MARKDOWN_EXTENSION = ".md";
const NOTE_PATH_MAX_LENGTH = 512;
const NOTE_SEGMENT_MAX_LENGTH = 180;

export interface StoredNoteSummary {
  path: string;
  name: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  sizeBytes: number;
}

export interface StoredNoteDocument extends StoredNoteSummary {
  content: string;
}

export interface StoredNoteFileNode extends StoredNoteSummary {
  kind: "file";
}

export interface StoredNoteFolderNode {
  kind: "folder";
  path: string;
  name: string;
  children: StoredNoteTreeNode[];
}

export type StoredNoteTreeNode = StoredNoteFileNode | StoredNoteFolderNode;

export interface SaveNoteResult {
  created: boolean;
  note: StoredNoteDocument;
}

export interface CreateFolderResult {
  created: boolean;
  folder: StoredNoteFolderNode;
}

interface NormalizedNotePath {
  path: string;
  name: string;
  segments: string[];
  parentSegments: string[];
}

export class NoteStorageError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "NoteStorageError";
    this.statusCode = statusCode;
  }
}

export function resolveNotesDir(dataDir: string): string {
  return resolve(dataDir, NOTES_DIRECTORY_NAME);
}

export async function listNotesTree(dataDir: string): Promise<StoredNoteTreeNode[]> {
  const notesDir = await ensureNotesDir(dataDir);
  return listTreeEntries(notesDir, []);
}

export async function readNote(dataDir: string, rawPath: string): Promise<StoredNoteDocument> {
  const notePath = normalizeNotePath(rawPath);
  const notesDir = await ensureNotesDir(dataDir);
  const filePath = await resolveExistingEntryPath(notesDir, notePath, "file");

  const [content, fileStats] = await Promise.all([
    readFile(filePath, "utf8"),
    stat(filePath)
  ]);

  return {
    ...toStoredNoteSummary(notePath.path, fileStats, content),
    content
  };
}

export async function saveNote(
  dataDir: string,
  rawPath: string,
  content: string
): Promise<SaveNoteResult> {
  const notePath = normalizeNotePath(rawPath);
  const notesDir = await ensureNotesDir(dataDir);
  const parentDirectoryPath = await ensureDirectoryChain(notesDir, notePath.parentSegments);
  const filePath = resolve(parentDirectoryPath, notePath.name);
  const tempPath = resolve(parentDirectoryPath, `.${notePath.name}.${randomUUID()}.tmp`);
  let created = false;

  try {
    await assertRegularNoteFile(filePath, notePath.path);
  } catch (error) {
    if (isMissingFileError(error)) {
      created = true;
    } else {
      throw error;
    }
  }

  try {
    await writeFile(tempPath, content, { encoding: "utf8", flag: "wx" });
    await rename(tempPath, filePath);
  } catch (error) {
    await removeIfExists(tempPath);
    throw error;
  }

  return {
    created,
    note: await readNote(dataDir, notePath.path)
  };
}

export async function renameNote(
  dataDir: string,
  rawPath: string,
  rawNewPath: string
): Promise<StoredNoteDocument> {
  const currentPath = normalizeNotePath(rawPath);
  const nextPath = normalizeNotePath(rawNewPath, "newFilename");

  if (currentPath.path === nextPath.path) {
    return readNote(dataDir, currentPath.path);
  }

  const notesDir = await ensureNotesDir(dataDir);
  const sourcePath = await resolveExistingEntryPath(notesDir, currentPath, "file");
  const targetParentDirectoryPath = await ensureDirectoryChain(notesDir, nextPath.parentSegments);
  const targetPath = resolve(targetParentDirectoryPath, nextPath.name);

  await assertRenameTargetAvailable(sourcePath, targetPath, nextPath.path);
  await rename(sourcePath, targetPath);

  return readNote(dataDir, nextPath.path);
}

export async function deleteNote(dataDir: string, rawPath: string): Promise<void> {
  const notePath = normalizeNotePath(rawPath);
  const notesDir = await ensureNotesDir(dataDir);
  const filePath = await resolveExistingEntryPath(notesDir, notePath, "file");
  await unlink(filePath);
}

export async function createFolder(
  dataDir: string,
  rawPath: string
): Promise<CreateFolderResult> {
  const folderPath = normalizeFolderPath(rawPath);
  const notesDir = await ensureNotesDir(dataDir);
  const parentDirectoryPath = await ensureDirectoryChain(notesDir, folderPath.parentSegments);
  const targetPath = resolve(parentDirectoryPath, folderPath.name);
  let created = false;

  try {
    await assertRegularDirectory(targetPath, folderPath.path, false);
  } catch (error) {
    if (isMissingFileError(error)) {
      await mkdir(targetPath);
      created = true;
    } else {
      throw error;
    }
  }

  return {
    created,
    folder: {
      kind: "folder",
      path: folderPath.path,
      name: folderPath.name,
      children: []
    }
  };
}

export async function deleteFolder(dataDir: string, rawPath: string): Promise<void> {
  const folderPath = normalizeFolderPath(rawPath);
  const notesDir = await ensureNotesDir(dataDir);
  const directoryPath = await resolveExistingEntryPath(notesDir, folderPath, "directory");
  await rm(directoryPath, { recursive: true, force: false });
}

async function listTreeEntries(
  directoryPath: string,
  parentSegments: string[]
): Promise<StoredNoteTreeNode[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const nodes = await Promise.all(entries.map(async (entry): Promise<StoredNoteTreeNode | null> => {
    const currentSegments = [...parentSegments, entry.name];
    const currentPath = currentSegments.join("/");
    const absolutePath = resolve(directoryPath, entry.name);

    if (entry.isSymbolicLink()) {
      return null;
    }

    if (entry.isDirectory()) {
      return {
        kind: "folder",
        path: currentPath,
        name: entry.name,
        children: await listTreeEntries(absolutePath, currentSegments)
      };
    }

    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(MARKDOWN_EXTENSION)) {
      return null;
    }

    const [content, fileStats] = await Promise.all([
      readFile(absolutePath, "utf8"),
      stat(absolutePath)
    ]);

    return {
      kind: "file",
      ...toStoredNoteSummary(currentPath, fileStats, content)
    };
  }));

  return sortTreeNodes(nodes.filter((node): node is StoredNoteTreeNode => node !== null));
}

async function ensureNotesDir(dataDir: string): Promise<string> {
  const notesDir = resolveNotesDir(dataDir);
  await mkdir(notesDir, { recursive: true });
  await assertRegularDirectory(notesDir, NOTES_DIRECTORY_NAME, true);
  return notesDir;
}

async function ensureDirectoryChain(
  notesDir: string,
  segments: string[]
): Promise<string> {
  let currentPath = notesDir;
  const walkedSegments: string[] = [];

  for (const segment of segments) {
    walkedSegments.push(segment);
    const relativePath = walkedSegments.join("/");
    const nextPath = resolve(currentPath, segment);

    try {
      await assertRegularDirectory(nextPath, relativePath, false);
    } catch (error) {
      if (isMissingFileError(error)) {
        await mkdir(nextPath);
      } else {
        throw error;
      }
    }

    currentPath = nextPath;
  }

  return currentPath;
}

async function resolveExistingEntryPath(
  notesDir: string,
  normalizedPath: NormalizedNotePath,
  expectedKind: "file" | "directory"
): Promise<string> {
  let currentPath = notesDir;
  const walkedSegments: string[] = [];

  for (const [index, segment] of normalizedPath.segments.entries()) {
    walkedSegments.push(segment);
    const relativePath = walkedSegments.join("/");
    const nextPath = resolve(currentPath, segment);
    const isLeaf = index === normalizedPath.segments.length - 1;

    try {
      if (isLeaf) {
        if (expectedKind === "file") {
          await assertRegularNoteFile(nextPath, normalizedPath.path);
        } else {
          await assertRegularDirectory(nextPath, normalizedPath.path, false);
        }
      } else {
        await assertRegularDirectory(nextPath, relativePath, false);
      }
    } catch (error) {
      if (isMissingFileError(error)) {
        const itemLabel = expectedKind === "file" ? "Note" : "Folder";
        throw new NoteStorageError(404, `${itemLabel} "${normalizedPath.path}" was not found.`);
      }

      throw error;
    }

    currentPath = nextPath;
  }

  return currentPath;
}

async function assertRenameTargetAvailable(
  sourcePath: string,
  targetPath: string,
  notePath: string
): Promise<void> {
  try {
    const [sourceStats, targetStats] = await Promise.all([
      lstat(sourcePath),
      lstat(targetPath)
    ]);

    if (sourceStats.dev === targetStats.dev && sourceStats.ino === targetStats.ino) {
      return;
    }

    throw new NoteStorageError(409, `Note "${notePath}" already exists.`);
  } catch (error) {
    if (isMissingFileError(error)) {
      return;
    }

    throw error;
  }
}

async function assertRegularNoteFile(filePath: string, notePath: string): Promise<void> {
  const fileStats = await lstat(filePath);

  if (fileStats.isSymbolicLink()) {
    throw new NoteStorageError(400, `Note "${notePath}" must not be a symbolic link.`);
  }

  if (!fileStats.isFile()) {
    throw new NoteStorageError(400, `Note "${notePath}" must be a regular file.`);
  }
}

async function assertRegularDirectory(
  directoryPath: string,
  relativePath: string,
  isNotesRoot: boolean
): Promise<void> {
  const directoryStats = await lstat(directoryPath);
  const directoryLabel = isNotesRoot ? "Notes directory" : `Folder "${relativePath}"`;

  if (directoryStats.isSymbolicLink()) {
    throw new NoteStorageError(400, `${directoryLabel} must not be a symbolic link.`);
  }

  if (!directoryStats.isDirectory()) {
    throw new NoteStorageError(400, `${directoryLabel} must be a directory.`);
  }
}

function normalizeNotePath(rawPath: string, fieldLabel = "path"): NormalizedNotePath {
  const normalizedPath = normalizeRelativePath(rawPath, fieldLabel);

  if (!normalizedPath.path.toLowerCase().endsWith(MARKDOWN_EXTENSION)) {
    throw new NoteStorageError(400, `${fieldLabel} must end with "${MARKDOWN_EXTENSION}".`);
  }

  return normalizedPath;
}

function normalizeFolderPath(rawPath: string): NormalizedNotePath {
  return normalizeRelativePath(rawPath, "folderPath");
}

function normalizeRelativePath(rawPath: string, fieldLabel: string): NormalizedNotePath {
  const path = rawPath.trim();

  if (path.length === 0) {
    throw new NoteStorageError(400, `${fieldLabel} must be a non-empty string.`);
  }

  if (path.length > NOTE_PATH_MAX_LENGTH) {
    throw new NoteStorageError(400, `${fieldLabel} must be at most ${NOTE_PATH_MAX_LENGTH} characters.`);
  }

  if (path.includes("\\") || path.includes("\0")) {
    throw new NoteStorageError(400, `${fieldLabel} must use forward-slash path separators only.`);
  }

  const segments = path.split("/");

  if (segments.some((segment) => segment.length === 0)) {
    throw new NoteStorageError(400, `${fieldLabel} must not include empty path segments.`);
  }

  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new NoteStorageError(400, `${fieldLabel} must not include "." or ".." segments.`);
    }

    if (segment.length > NOTE_SEGMENT_MAX_LENGTH) {
      throw new NoteStorageError(
        400,
        `Each ${fieldLabel} segment must be at most ${NOTE_SEGMENT_MAX_LENGTH} characters.`
      );
    }
  }

  return {
    path: segments.join("/"),
    name: segments.at(-1) ?? path,
    segments,
    parentSegments: segments.slice(0, -1)
  };
}

function toStoredNoteSummary(
  notePath: string,
  fileStats: { birthtime: Date; birthtimeMs: number; mtime: Date; size: number },
  content: string
): StoredNoteSummary {
  const createdAt =
    fileStats.birthtimeMs > 0 ? fileStats.birthtime.toISOString() : fileStats.mtime.toISOString();
  const noteName = basename(notePath);

  return {
    path: notePath,
    name: noteName,
    title: extractNoteTitle(noteName, content),
    createdAt,
    updatedAt: fileStats.mtime.toISOString(),
    sizeBytes: fileStats.size
  };
}

function extractNoteTitle(noteName: string, content: string): string {
  const headingLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^#{1,6}\s+\S/.test(line));

  if (headingLine) {
    return headingLine.replace(/^#{1,6}\s+/, "").trim();
  }

  const baseTitle = noteName.slice(0, -MARKDOWN_EXTENSION.length).replace(/[-_]+/g, " ").trim();
  if (!baseTitle) {
    return "Untitled note";
  }

  return baseTitle.replace(/\b\w/g, (match) => match.toUpperCase());
}

function sortTreeNodes(nodes: StoredNoteTreeNode[]): StoredNoteTreeNode[] {
  return [...nodes].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "folder" ? -1 : 1;
    }

    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}

async function removeIfExists(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}
