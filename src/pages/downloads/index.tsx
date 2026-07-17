import { ArrowDownTrayIcon, DocumentIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import type { ReactElement } from "react";
import { useState } from "react";
import toast from "react-hot-toast";
import { LayoutAuthenticated } from "~/components/layouts/layout";
import MetaTags from "~/components/shared/metaTags";
import { getServerSideProps } from "~/server/getServerSideProps";
import { api } from "~/utils/api";
import type { NextPageWithLayout } from "../_app";

const Downloads: NextPageWithLayout = () => {
	const t = useTranslations("downloads");
	const [isDownloading, setIsDownloading] = useState(false);
	const { data: globalOptions, isLoading } = api.settings.getAllOptions.useQuery();
	const planetAvailable = globalOptions?.planetDownloadAvailable === true;
	const title = `${globalOptions?.siteName ?? "ZTNET"} - ${t("title")}`;

	const downloadPlanet = async () => {
		setIsDownloading(true);
		try {
			const response = await fetch("/api/planet", { cache: "no-store" });
			if (!response.ok) throw new Error(`Planet download failed: ${response.status}`);

			const blob = await response.blob();
			const url = window.URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = "planet";
			anchor.style.display = "none";
			document.body.appendChild(anchor);
			anchor.click();
			anchor.remove();
			window.URL.revokeObjectURL(url);
			toast.success(t("downloadSuccess"));
		} catch (error) {
			console.error("Unable to download planet", error);
			toast.error(t("downloadError"));
		} finally {
			setIsDownloading(false);
		}
	};

	return (
		<div className="animate-fadeIn">
			<MetaTags title={title} />
			<main className="w-full bg-base-100">
				<header className="border-b border-base-300 px-4 py-5 md:px-10">
					<div className="mx-auto max-w-5xl">
						<h1 className="text-2xl font-semibold">{t("title")}</h1>
						<p className="mt-1 text-sm text-base-content/60">{t("subtitle")}</p>
					</div>
				</header>

				<div className="mx-auto max-w-5xl px-4 py-8 md:px-10">
					<section className="overflow-hidden rounded-lg border border-base-300 bg-base-100">
						<div className="flex flex-col gap-4 border-b border-base-300 bg-base-200/40 p-5 sm:flex-row sm:items-center sm:justify-between">
							<div className="flex min-w-0 items-center gap-3">
								<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
									<DocumentIcon className="h-6 w-6" />
								</div>
								<div className="min-w-0">
									<h2 className="text-lg font-semibold">{t("planetTitle")}</h2>
									<p className="text-sm text-base-content/60">{t("planetDescription")}</p>
								</div>
							</div>
							{isLoading ? (
								<span className="loading loading-spinner loading-sm text-primary" />
							) : (
								<span
									className={`badge badge-outline h-7 px-3 ${
										planetAvailable ? "badge-success" : "badge-ghost"
									}`}
								>
									{planetAvailable ? t("available") : t("unavailable")}
								</span>
							)}
						</div>

						<div className="grid gap-6 p-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
							<div className="grid gap-4 sm:grid-cols-2">
								<div>
									<p className="text-xs text-base-content/50">{t("fileName")}</p>
									<p className="mt-1 font-mono text-sm font-semibold">planet</p>
								</div>
								<div>
									<p className="text-xs text-base-content/50">{t("fileType")}</p>
									<p className="mt-1 text-sm font-medium">{t("binaryFile")}</p>
								</div>
								{!isLoading && !planetAvailable ? (
									<p className="text-sm text-warning sm:col-span-2">
										{t("unavailableDescription")}
									</p>
								) : null}
							</div>

							<button
								type="button"
								className="btn btn-primary min-h-10 min-w-40 gap-2"
								disabled={isLoading || !planetAvailable || isDownloading}
								onClick={() => void downloadPlanet()}
							>
								{isDownloading ? (
									<span className="loading loading-spinner loading-sm" />
								) : (
									<ArrowDownTrayIcon className="h-5 w-5" />
								)}
								<span>{isDownloading ? t("downloading") : t("downloadButton")}</span>
							</button>
						</div>
					</section>
				</div>
			</main>
		</div>
	);
};

Downloads.getLayout = function getLayout(page: ReactElement) {
	return <LayoutAuthenticated>{page}</LayoutAuthenticated>;
};

export { getServerSideProps };
export default Downloads;
