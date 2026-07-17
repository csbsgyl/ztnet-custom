import { useModalStore } from "~/utils/store";

describe("modal store", () => {
	afterEach(() => {
		useModalStore.getState().closeModal?.();
	});

	it("keeps the modal open when new content replaces an open modal", () => {
		const callModal = useModalStore.getState().callModal;
		callModal({ title: "First", content: <p>First</p> });
		callModal({ title: "Second", content: <p>Second</p> });

		expect(useModalStore.getState()).toMatchObject({
			isOpen: true,
			title: "Second",
		});
	});
});
