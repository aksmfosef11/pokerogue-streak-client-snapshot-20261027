// SPDX-License-Identifier: AGPL-3.0-only
import { globalScene } from "#app/global-scene";
import { TextStyle } from "#enums/text-style";
import { Button } from "#enums/buttons";
import { UiMode } from "#enums/ui-mode";
import type { OptionSelectItem, UIOptionSelectItem } from "#types/ui-types";
import { OptionSelectUiHandler } from "#ui/option-select-ui-handler";
import { addTextObject } from "#ui/text";
import { addWindow } from "#ui/ui-theme";
import type { UI } from "#ui/ui";
import type { UiHandler } from "#ui/ui-handler";

export interface PanelData {
  title: string;
  description: string;
  badge?: string;
  stats?: { label: string; value: string }[];
  options: OptionSelectItem[];
}

// Use the game's own window skin, fonts, cursor, scrolling and input mappings.
// Temporarily use the ordinary option-select slot, restoring it on close.
class PvpMenuHandler extends OptionSelectUiHandler {
  private heading!: Phaser.GameObjects.Container;
  private background!: Phaser.GameObjects.NineSlice;
  private titleText!: Phaser.GameObjects.Text;
  private descriptionText!: Phaser.GameObjects.Text;
  private versionText!: Phaser.GameObjects.Text;
  private menuKey?: string;
  private previousDisableMenu = false;
  private readonly selections = new Map<string, number>();
  private back: (() => boolean) | undefined;
  private canceling = false;

  override setup(): void {
    super.setup();
    const width = globalScene.scaledCanvas.width || 320;
    const height = globalScene.scaledCanvas.height || 180;
    this.heading = globalScene.add.container(0, -height).setName("pvp-menu-heading").setVisible(false);
    this.heading.add(addWindow(1, 1, width - 2, height - 2));
    this.background = addWindow(1, 1, width - 2, 44);
    this.titleText = addTextObject(9, 6, "", TextStyle.WINDOW, { fontSize: "64px" });
    this.versionText = addTextObject(width - 9, 8, "", TextStyle.WINDOW, { fontSize: "42px" }).setOrigin(1, 0);
    this.descriptionText = addTextObject(9, 22, "", TextStyle.WINDOW, { fontSize: "48px" });
    this.descriptionText.setWordWrapWidth((width - 18) / this.descriptionText.scaleX, true);
    this.heading.add([this.background, this.titleText, this.versionText, this.descriptionText]);
    globalScene.ui.add(this.heading);
  }

  override show(args: any[]): boolean {
    const data = args[0] as PanelData;
    const height = globalScene.scaledCanvas.height || 180;
    this.menuKey = `${data.title}:${data.badge ?? ""}`;
    this.previousDisableMenu = globalScene.disableMenu;
    globalScene.disableMenu = true;
    this.titleText.setText(data.title);
    this.versionText.setText(data.badge ?? "");
    const stats = data.stats?.map(s => `${s.label} ${s.value}`).join(" · ");
    this.descriptionText.setText([stats, data.description].filter(Boolean).join("\n"));
    const headingHeight = Math.min(height - 62, Math.max(36, 28 + (this.descriptionText.displayHeight || 0)));
    this.background.setSize(globalScene.scaledCanvas.width - 2, headingHeight);
    const maxOptions = Math.max(2, Math.min(7, Math.floor((height - headingHeight - 6) / 16) - 1));
    const shown = super.show([
      { options: data.options.map(o => ({ ...o, keepOpen: true })), maxOptions, yOffset: 1, blockCancelButton: false },
    ]);
    this.heading.setVisible(true);
    globalScene.ui.bringToTop(this.heading);
    globalScene.ui.bringToTop(this.optionSelectContainer);
    const selected = Math.min(this.selections.get(this.menuKey) ?? 0, data.options.length - 1);
    this.setScrollCursor(Math.max(0, selected - maxOptions + 1));
    this.setCursor(Math.min(selected, maxOptions - 1));
    document.getElementById("touchControls")?.setAttribute("data-ui-mode", "OPTION_SELECT");
    this.back = data.options.at(-1)?.handler;
    return shown;
  }

  protected override updateSizeForOptions(options: (UIOptionSelectItem & OptionSelectItem)[]): void {
    super.updateSizeForOptions(options);
    const width = (globalScene.scaledCanvas.width || 320) - 2;
    this.optionSelectBg.setSize(width, this.optionSelectBg.height);
    this.optionSelectText.setX(-width + 11 + 24 * this.scale);
  }

  override processInput(button: Button): boolean {
    if (button === Button.CANCEL && this.back) {
      if (this.menuKey) this.selections.set(this.menuKey, this.cursor + this.scrollCursor);
      this.canceling = true;
      const success = this.back();
      this.canceling = false;
      if (success) this.getUi().playSelect();
      return success;
    }
    return super.processInput(button);
  }

  override clear(): void {
    if (this.active && this.menuKey && !this.canceling)
      this.selections.set(this.menuKey, this.cursor + this.scrollCursor);
    super.clear();
    this.heading?.setVisible(false);
    globalScene.disableMenu = this.previousDisableMenu;
  }

  override destroy(): void {
    this.heading?.destroy(true);
    this.selections.clear();
  }
}

const handlers = new WeakMap<UI, { original: UiHandler; handler: PvpMenuHandler }>();
export function closePvpPanel(): void {
  const state = handlers.get(globalScene.ui);
  if (state?.handler.active) state.handler.clear();
  if (state && globalScene.ui.handlers[UiMode.OPTION_SELECT] === state.handler)
    globalScene.ui.handlers[UiMode.OPTION_SELECT] = state.original;
}
export function showPvpPanel(data: PanelData): void {
  const ui = globalScene.ui;
  let state = handlers.get(ui);
  if (!state) {
    const handler = new PvpMenuHandler(UiMode.OPTION_SELECT);
    handler.setup();
    state = { original: ui.handlers[UiMode.OPTION_SELECT], handler };
    handlers.set(ui, state);
  }
  if (ui.mode === UiMode.OPTION_SELECT) {
    ui.getHandler().clear();
    ui.handlers[UiMode.OPTION_SELECT] = state.handler;
    state.handler.show([data]);
  } else {
    ui.handlers[UiMode.OPTION_SELECT] = state.handler;
    void ui.setMode(UiMode.OPTION_SELECT, data);
  }
}

export function panelUi(failure: (error: unknown, retry: () => void) => void) {
  let description = "";
  return {
    message: (text: string, next: () => void) => {
      description = text;
      next();
    },
    options: (options: OptionSelectItem[]) => {
      const [title, ...lines] = description.split("\n");
      showPvpPanel({ title: title || "연승전", description: lines.join("\n"), options });
    },
    failure,
  };
}
