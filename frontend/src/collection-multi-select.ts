export interface CollectionOption {
	id: string;
	name: string;
	kind: string;
}

export interface CollectionMultiSelectOptions {
	collections: readonly CollectionOption[];
	selectedIds: readonly string[];
	inputName: string;
	emptyMessage: string;
	onChange?: (selectedIds: string[]) => void;
}

export function renderCollectionMultiSelect(
	container: HTMLElement,
	options: CollectionMultiSelectOptions,
): void {
	const selected = new Set(options.selectedIds);
	const summary = selected.size
		? `${selected.size} collection${selected.size === 1 ? "" : "s"} selected`
		: "All collections";
	container.innerHTML = options.collections.length
		? `<details class="collection-multi-select">
        <summary>${escapeHtml(summary)}</summary>
        <div class="collection-multi-select-panel">
          <input class="collection-multi-select-search" type="search" placeholder="Search collections" aria-label="Search collections" />
          <div class="checklist">
            ${options.collections
				.map(
					(collection) => `<label data-keywords="${escapeHtml(`${collection.name} ${collection.kind}`.toLocaleLowerCase())}">
                <input type="checkbox" name="${escapeHtml(options.inputName)}" value="${escapeHtml(collection.id)}"${selected.has(collection.id) ? " checked" : ""} />
                <span>${escapeHtml(collection.name)} · ${escapeHtml(collection.kind)}</span>
              </label>`,
				)
				.join("")}
          </div>
        </div>
      </details>`
		: `<div class="drawer-empty">${escapeHtml(options.emptyMessage)}</div>`;

	const search = container.querySelector<HTMLInputElement>(
		".collection-multi-select-search",
	);
	search?.addEventListener("input", () => {
		const query = search.value.trim().toLocaleLowerCase();
		for (const label of container.querySelectorAll<HTMLLabelElement>(
			"[data-keywords]",
		)) {
			label.hidden = !label.dataset.keywords?.includes(query);
		}
	});

	const notifyChange = () => {
		options.onChange?.(
			Array.from(
				container.querySelectorAll<HTMLInputElement>(
					`input[name="${options.inputName}"]:checked`,
				),
			).map((input) => input.value),
		);
	};
	for (const checkbox of container.querySelectorAll<HTMLInputElement>(
		`input[name="${options.inputName}"]`,
	)) {
		checkbox.addEventListener("change", notifyChange);
	}
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}
