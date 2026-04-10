import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ROUTES } from "@/lib/constants";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { clearError, loginUser } from "@/store/slices/userSlice";
import { authService } from "@/services/authService";

export type AuthMode = "login" | "register";

export type AuthFormData = {
  username: string;
  password: string;
  confirmPassword: string;
};

const initialFormData: AuthFormData = {
  username: "",
  password: "",
  confirmPassword: "",
};

export function useAuthPageController() {
  const [mode, setMode] = useState<AuthMode>("login");
  const [formData, setFormData] = useState<AuthFormData>(initialFormData);
  const [registerLoading, setRegisterLoading] = useState(false);
  const [localError, setLocalError] = useState("");

  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const { loading, error, isAuthenticated } = useAppSelector(
    (state) => state.user,
  );

  useEffect(() => {
    if (isAuthenticated) {
      navigate(ROUTES.home);
    }
    return () => {
      dispatch(clearError());
    };
  }, [isAuthenticated, navigate, dispatch]);

  const switchMode = (nextMode: AuthMode) => {
    setMode(nextMode);
    setLocalError("");
    dispatch(clearError());
  };

  const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = event.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    setLocalError("");
    if (error) {
      dispatch(clearError());
    }
  };

  const handleSubmit = async () => {
    if (!formData.username || !formData.password) {
      setLocalError("请输入用户名和密码");
      return;
    }

    if (mode === "login") {
      dispatch(
        loginUser({ username: formData.username, password: formData.password }),
      );
      return;
    }

    if (formData.password !== formData.confirmPassword) {
      setLocalError("两次输入的密码不一致");
      return;
    }

    setRegisterLoading(true);
    try {
      await authService.register({
        username: formData.username,
        password: formData.password,
      });
      setMode("login");
      setLocalError("");
      alert("注册成功，请登录");
    } catch (submitError: unknown) {
      const message =
        submitError instanceof Error ? submitError.message : "注册失败";
      setLocalError(message);
    } finally {
      setRegisterLoading(false);
    }
  };

  return {
    mode,
    isLogin: mode === "login",
    formData,
    loading,
    error,
    registerLoading,
    localError,
    switchMode,
    handleInputChange,
    handleSubmit,
  };
}
