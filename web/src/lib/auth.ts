import type { Session } from '@supabase/supabase-js';
import { getSupabaseClient, supabase } from './supabase';
import type {
  AccountStatus,
  Profile,
  PublicRuntimeConfig,
  SignupTeacher,
  TeacherBasicInfo,
  UserRole,
} from './types';

export async function fetchTeachers(): Promise<SignupTeacher[]> {
  const client = getSupabaseClient();
  const { data, error } = await client.rpc('get_signup_teachers');
  if (error) throw error;
  return (data as SignupTeacher[]) || [];
}

export async function getMyTeacherInfo(): Promise<TeacherBasicInfo | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc('get_my_teacher_info');
  if (error) {
    console.warn('Không thể tải thông tin giáo viên phụ trách:', error.message);
    return null;
  }
  return Array.isArray(data) ? (data[0] as TeacherBasicInfo) || null : (data as TeacherBasicInfo) || null;
}

export async function getPublicRuntimeConfig(): Promise<PublicRuntimeConfig | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc('get_public_runtime_config');
  if (error) {
    console.warn('Lỗi lấy cấu hình hệ thống công khai:', error.message);
    return null;
  }
  return Array.isArray(data) ? (data[0] as PublicRuntimeConfig) || null : (data as PublicRuntimeConfig) || null;
}

export interface SignUpParams {
  email: string;
  password: string;
  fullName: string;
  phone?: string;
  role: 'student' | 'teacher';
  teacherId?: string | null;
  voiceUrl?: string | null;
  voiceEmbeddings?: number[] | number[][] | null;
}

export async function signUp({
  email,
  password,
  fullName,
  phone,
  role,
  teacherId,
  voiceUrl,
  voiceEmbeddings,
}: SignUpParams) {
  const client = getSupabaseClient();
  const safeRole: 'student' | 'teacher' = role === 'teacher' ? 'teacher' : 'student';
  const initialStatus: AccountStatus = safeRole === 'teacher' ? 'pending' : 'active';

  const { data: authData, error: authError } = await client.auth.signUp({
    email,
    password,
    options: {
      data: {
        full_name: fullName,
        requested_role: safeRole,
      },
    },
  });

  if (authError) {
    if (authError.message.includes('User already registered') || authError.status === 400) {
      throw new Error(
        'Email này đã từng được sử dụng (có thể do lỗi đăng ký nửa chừng trước đó). Vui lòng sang tab Đăng nhập, hoặc dùng một Email khác!',
      );
    }
    throw authError;
  }

  const user = authData.user;
  if (user && authData.session) {
    const hasEmb = Boolean(
      voiceUrl ||
        (voiceEmbeddings && (Array.isArray(voiceEmbeddings) ? voiceEmbeddings.length > 0 : true)),
    );
    const { error: profileError } = await client.from('profiles').insert({
      id: user.id,
      role: safeRole,
      status: initialStatus,
      full_name: fullName,
      email,
      phone: phone || null,
      teacher_id: safeRole === 'student' ? teacherId || null : null,
      voice_enrolled: hasEmb,
      voice_sample_url: voiceUrl || null,
      voice_embeddings: voiceEmbeddings || null,
    });
    if (profileError) throw profileError;
  }

  return {
    ...authData,
    role: safeRole,
    status: initialStatus,
    needsEmailVerification: Boolean(user && !authData.session),
  };
}

export async function signIn({ email, password }: { email: string; password: string }) {
  const client = getSupabaseClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut(): Promise<void> {
  const client = getSupabaseClient();
  const { error } = await client.auth.signOut();
  if (error) throw error;
}

export async function getSession(): Promise<Session | null> {
  if (!supabase) return null;
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session;
}

export async function getAccessToken(): Promise<string> {
  const session = await getSession();
  return session?.access_token || '';
}

export async function getAuthHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function getProfile(userId: string): Promise<Profile> {
  const client = getSupabaseClient();
  const { data, error } = await client.from('profiles').select('*').eq('id', userId).single();
  if (error) throw error;
  return data as Profile;
}

export async function updateProfile(userId: string, updates: Partial<Profile>): Promise<Profile> {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from('profiles')
    .update(updates)
    .eq('id', userId)
    .select()
    .single();
  if (error) throw error;
  return data as Profile;
}

/**
 * Cập nhật GPU Backend Tunnel URL (Chỉ Admin).
 * Bản demo loại bỏ cấu hình AI API Key khỏi giao diện Admin; giữ an toàn key server-side hiện có.
 */
export async function updateGlobalGpuUrl(apiUrl: string): Promise<{ api_url?: string }> {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from('global_settings')
    .upsert({
      id: 1,
      api_url: apiUrl.trim(),
      updated_at: new Date().toISOString(),
    })
    .select('id, api_url, updated_at')
    .single();
  if (error) throw error;
  return data as { api_url?: string };
}

export async function adminUpdateUser(
  userId: string,
  { role, status, teacherId = null }: { role: UserRole; status: AccountStatus; teacherId?: string | null },
) {
  const client = getSupabaseClient();
  const { data, error } = await client.rpc('admin_update_user', {
    p_user_id: userId,
    p_role: role,
    p_status: status,
    p_teacher_id: teacherId || null,
  });
  if (error) throw error;
  return data;
}

export async function deleteUserByAdmin(userId: string): Promise<void> {
  const client = getSupabaseClient();
  const { error } = await client.rpc('delete_user_by_admin', { user_id: userId });
  if (error) throw error;
}

