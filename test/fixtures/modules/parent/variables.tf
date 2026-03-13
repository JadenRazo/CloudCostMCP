variable "environment" {
  description = "Deployment environment"
  type        = string
  default     = "production"
}

variable "child_instance_type" {
  description = "Instance type passed down to the child module"
  type        = string
  default     = "t3.micro"
}
