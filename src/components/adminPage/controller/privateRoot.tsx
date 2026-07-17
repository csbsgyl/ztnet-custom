import { useTranslations } from "next-intl";
import React, { useCallback, useRef, useState } from "react";
import toast from "react-hot-toast";
import { api } from "~/utils/api";
import { useModalStore } from "~/utils/store";
import RootForm from "./rootForm";
import Link from "next/link";
import CreatePlanet from "./createPlanet";
import { usePlanetRestartPrompt } from "./planetRestartPrompt";

const PrivateRoot = () => {
	const t = useTranslations("admin");
	const [open, setOpen] = useState(false);
	const [isOperationPending, setIsOperationPending] = useState(false);
	const operationInFlight = useRef(false);
	const callModal = useModalStore((state) => state.callModal);
	const showPlanetRestartPrompt = usePlanetRestartPrompt();
	const { data: getPlanet, refetch: refetchPlanet } = api.admin.getPlanet.useQuery();
	const beginOperation = useCallback(() => {
		if (operationInFlight.current) return false;
		operationInFlight.current = true;
		setIsOperationPending(true);
		return true;
	}, []);
	const endOperation = useCallback(() => {
		operationInFlight.current = false;
		setIsOperationPending(false);
	}, []);

	const closeForm = () => setOpen(false);
	const { mutate: resetWorld } = api.admin.resetWorld.useMutation({
		onSuccess: () => {
			void refetchPlanet();
			showPlanetRestartPrompt("restored");
		},
		onError: (error) => {
			toast.error(error.message || "Unable to restore the original Planet.");
		},
		onSettled: endOperation,
	});
	const requestResetWorld = () => {
		if (beginOperation()) resetWorld();
	};
	async function downloadPlanet() {
		try {
			const response = await fetch("/api/mkworld/config");
			if (!response.ok) {
				throw new Error("Network response was not ok");
			}
			const blob = await response.blob();
			const url = window.URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.style.display = "none";
			a.href = url;
			a.download = "ztnet-world.zip";
			document.body.appendChild(a);
			a.click();
			window.URL.revokeObjectURL(url);
		} catch (error) {
			console.error("There was an error downloading the file:", error);
		}
	}
	const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		event.target.value = "";
		if (file) {
			void uploadFile(file);
		}
	};

	const triggerFileInput = () => {
		if (isOperationPending) return;
		const fileInput = document.getElementById("fileInput") as HTMLInputElement | null;
		fileInput?.click();
	};

	const uploadFile = async (file: File) => {
		if (!beginOperation()) return;
		const formData = new FormData();
		formData.append("file", file);

		try {
			const response = await fetch("/api/mkworld/config", {
				method: "POST",
				body: formData,
			});
			if (!response.ok) {
				const data = (await response.json()) as { error?: string };
				throw new Error(data.error || "Unknown error");
			}
			await response.json();
			void refetchPlanet();
			showPlanetRestartPrompt("imported");
		} catch (error) {
			console.error("Error uploading the file:", error);
			toast.error(error instanceof Error ? error.message : "Unable to import Planet.");
		} finally {
			endOperation();
		}
	};
	return (
		<div className="space-y-4">
			<div>
				<p className="text-sm text-gray-500">
					{t("controller.generatePlanet.updatePlanetWarning")}
				</p>
				{getPlanet?.rootNodes?.length > 0 ? (
					<>
						<div className="space-y-4">
							<div className="alert">
								<svg
									xmlns="http://www.w3.org/2000/svg"
									fill="none"
									viewBox="0 0 24 24"
									className="stroke-info shrink-0 w-6 h-6"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth="2"
										d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
									></path>
								</svg>
								<span>{t("controller.generatePlanet.customPlanetInUse")}</span>
							</div>
							<div className="space-y-5">
								{getPlanet?.rootNodes?.map((node, i) => (
									<div key={node.id} className="border border-primary rounded p-4 my-4">
										{!node.endpoints.toString().includes("9993") ? (
											<div role="alert" className="alert shadow-lg mb-5">
												<svg
													xmlns="http://www.w3.org/2000/svg"
													fill="none"
													viewBox="0 0 24 24"
													className="stroke-info shrink-0 w-6 h-6"
												>
													<path
														strokeLinecap="round"
														strokeLinejoin="round"
														strokeWidth="2"
														d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
													></path>
												</svg>
												<div>
													<h3 className="font-bold">
														{t("controller.generatePlanet.customPortIsInUse")}
													</h3>
													<div className="text-xs">
														{t.rich(
															"controller.generatePlanet.customPortIsInUseDescription",
															{
																kbd: (content) => (
																	<kbd className="kbd kbd-xs">{content}</kbd>
																),
															},
														)}
													</div>
												</div>
											</div>
										) : null}
										<p className="tracking-wide font-medium">Root #{i + 1}</p>
										<p>
											<strong>Comments:</strong> {node.comments}
										</p>
										<p>
											<strong>Endpoints:</strong> {node.endpoints.toString()}
										</p>
										<p>
											<strong>Identity:</strong> {node.identity.substring(0, 50)}
										</p>
									</div>
								))}
							</div>
							<div>
								<p className=" text-sm">
									{t("controller.generatePlanet.downloadPlanetInfo")}{" "}
									<Link href="/api/planet" className="link text-blue-500">
										{t("controller.generatePlanet.downloadPlanetUrl")}
									</Link>
								</p>
							</div>
							<div className="flex justify-between">
								<div className="flex gap-3">
									<button
										onClick={() => downloadPlanet()}
										className="btn join-item bg-primary btn-sm"
										disabled={isOperationPending}
									>
										{t("controller.generatePlanet.buttons.downloadPlanetButton")}
									</button>
									<button
										onClick={() => setOpen(!open)}
										className="btn join-item btn-sm"
										disabled={isOperationPending}
									>
										{t("controller.generatePlanet.buttons.editPlanetConfig")}
									</button>
								</div>

								<button
									onClick={() =>
										callModal({
											title: t(
												"controller.generatePlanet.modal.restoreOriginalPlanetTitle",
											),
											content: t(
												"controller.generatePlanet.modal.restoreOriginalPlanetContent",
											),
											yesAction: () => {
												requestResetWorld();
												setOpen(false);
											},
										})
									}
									className="btn btn-outline btn-error btn-sm"
									disabled={isOperationPending}
								>
									{t("controller.generatePlanet.buttons.restoreOriginalPlanetButton")}
								</button>
							</div>
							{open ? (
								<RootForm
									onClose={closeForm}
									disabled={isOperationPending}
									beginOperation={beginOperation}
									endOperation={endOperation}
								/>
							) : null}
						</div>
					</>
				) : (
					<CreatePlanet
						getPlanet={getPlanet}
						resetWorld={requestResetWorld}
						open={open}
						setOpen={setOpen}
						handleFileChange={handleFileChange}
						triggerFileInput={triggerFileInput}
						closeForm={closeForm}
						isOperationPending={isOperationPending}
						beginOperation={beginOperation}
						endOperation={endOperation}
					/>
				)}
			</div>
		</div>
	);
};

export default PrivateRoot;
