export interface Story {
  sourceUrl: string;
  title: string;
  author?: string;
  tagline?: string;
  heroImageOriginalUrl?: string;
  heroImagePath?: string;
  heroImageUrl?: string;
  sectionTitles?: string[];
  contentBlocks?: StoryContentBlock[];
  text: string;
  wordCount: number;
  characterCount: number;
  extractedAt: string;
}

export type StoryContentBlockType = "paragraph" | "heading" | "list" | "quote";

export interface StoryContentBlock {
  type: StoryContentBlockType;
  text: string;
}

export interface WrittenStoryOutputs {
  slug: string;
  textPath: string;
  jsonPath: string;
}
