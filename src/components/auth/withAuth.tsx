import { GetServerSideProps } from "next";
import { getServerAuthSession } from "~/lib/authSession";
import { prisma } from "~/server/db";
import { canAccessProtectedResources } from "~/utils/accountAccess";

const protectedAccountSelect = {
	id: true,
	role: true,
	isActive: true,
	suspensionReason: true,
	expiresAt: true,
} as const;

export function withAuth(gssp: GetServerSideProps): GetServerSideProps {
	return async (context) => {
		const session = await getServerAuthSession({
			req: context.req,
			res: context.res,
		});
		const sessionUser = session?.user;

		if (!sessionUser) {
			return {
				redirect: { statusCode: 302, destination: "/auth/login" },
			};
		}

		const account = await prisma.user.findUnique({
			where: { id: sessionUser.id },
			select: protectedAccountSelect,
		});
		if (!account || !canAccessProtectedResources(account)) {
			return { notFound: true };
		}
		const user = { ...sessionUser, ...account };

		// ssp (server side props)
		const gsspData = await gssp(context);

		if (!("props" in gsspData)) {
			throw new Error("invalid getSSP result");
		}

		return {
			props: {
				...gsspData.props,
				user,
			},
		};
	};
}
