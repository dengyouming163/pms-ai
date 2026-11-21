export default function LoginLoading() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-[#064e3b] via-[#065f46] to-[#047857] flex items-center justify-center">
      <div className="w-[440px] mx-6">
        <div className="bg-white/[0.08] backdrop-blur-2xl rounded-3xl border border-white/[0.12] p-10 sm:p-12 animate-pulse">
          <div className="text-center mb-10">
            <div className="h-8 w-36 bg-white/10 rounded-lg mx-auto" />
            <div className="h-4 w-48 bg-white/5 rounded mt-3 mx-auto" />
          </div>
          <div className="space-y-5">
            <div className="space-y-2">
              <div className="h-4 w-12 bg-white/10 rounded" />
              <div className="h-12 bg-white/[0.06] rounded-xl" />
            </div>
            <div className="space-y-2">
              <div className="h-4 w-12 bg-white/10 rounded" />
              <div className="h-12 bg-white/[0.06] rounded-xl" />
            </div>
            <div className="h-12 bg-white/[0.06] rounded-xl mt-2" />
          </div>
        </div>
      </div>
    </div>
  );
}
